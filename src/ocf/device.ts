/**
 * One Samsung OCF appliance: DTLS session, discovery, state cache, polling,
 * OBSERVE push, writes, and reconnection with exponential backoff.
 *
 * Reconnection and tiered polling mirror the reference's coordinator: on a
 * dropped session it reconnects (1s → 30s backoff), re-discovers and re-seeds;
 * entities keep their last value meanwhile. OBSERVE is an optional accelerator
 * on top of polling (the reference's structural answer to OBSERVE going quiet
 * with no cloud route).
 */
import { EventEmitter } from "node:events";
import { DtlsClientTransport, type SignatureHash } from "../dtls/transport";
import { CoapSession } from "../coap/session";
import { encodeCbor, decodeCbor } from "./cbor";
import { parseDevice0Batch, deviceTypesFrom, type Rep, type OcfLink } from "./discovery";

export interface OcfDeviceOptions {
  host: string;
  port: number;
  cert: string;
  key: string;
  signatureHash?: SignatureHash;
  connectTimeoutMs?: number;
  pollIntervalMs?: number; // default 30s (the reference's cold cadence)
  coapTimeoutMs?: number; // per-request CoAP timeout, bounds a whole Block2 transfer (default 8s)
  rateLimitRps?: number; // request pacing (default 5/s, matching the reference)
  /** hrefs to OBSERVE for push updates (the Samsung /…/vs/0 siblings). */
  observeHrefs?: string[];
  /** Re-resolve the DTLS port before a reconnect (the port can change on a
   * power cycle). Called on each reconnect attempt; falls back to the last port. */
  resolvePort?: () => Promise<number | undefined>;
  logger?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
  /** injectable transport factory, for tests */
  makeTransport?: (o: OcfDeviceOptions) => DtlsClientTransport;
}

type DeviceEvents = {
  online: [];
  offline: [Error];
  update: [href: string, rep: Rep];
  discovered: [];
};

export class OcfDevice extends EventEmitter<DeviceEvents> {
  readonly state = new Map<string, Rep>();
  deviceTypes: string[] = [];
  oicD?: Rep;
  oicP?: Rep;

  private transport?: DtlsClientTransport;
  private session?: CoapSession;
  private pollTimer?: NodeJS.Timeout;
  private unobserve: Array<() => void> = [];
  private backoffMs = 1000;
  private running = false;
  private currentPort: number;

  constructor(private readonly opts: OcfDeviceOptions) {
    super();
    this.currentPort = opts.port;
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string): void {
    this.opts.logger?.(level, msg);
  }

  /** Connect, discover, seed state, start polling + observing. Never rejects:
   * a first-attempt failure (e.g. appliance off at startup) schedules a
   * background retry, so the accessory populates once the appliance appears. */
  async start(): Promise<void> {
    this.running = true;
    try {
      await this.connectAndDiscover();
    } catch (e) {
      this.log("warn", "connect failed: " + (e as Error).message + "; will retry");
      this.teardownSession();
      this.scheduleReconnect();
    }
  }

  private async connectAndDiscover(): Promise<void> {
    const transport = this.opts.makeTransport
      ? this.opts.makeTransport(this.opts)
      : new DtlsClientTransport({
          host: this.opts.host,
          port: this.currentPort,
          cert: this.opts.cert,
          key: this.opts.key,
          signatureHash: this.opts.signatureHash,
          connectTimeoutMs: this.opts.connectTimeoutMs,
        });
    this.transport = transport;
    transport.onClose = () => this.handleDrop(new Error("DTLS closed by peer"));
    transport.onError = (e) => this.log("warn", `transport error: ${e.message}`);

    await transport.connect();
    this.session = new CoapSession(transport, { defaultTimeoutMs: this.opts.coapTimeoutMs ?? 8000, rateLimitRps: this.opts.rateLimitRps ?? 5 });
    await this.discover();
    this.backoffMs = 1000;
    this.draining = false; // a freshly connected session may drop again later
    this.startPolling();
    await this.startObserving();
    this.emit("online");
  }

  /** Read /oic/d, /oic/p and the /device/0 batch; populate the state cache. */
  async discover(): Promise<void> {
    const s = this.session!;
    this.oicD = await this.tryGet(["oic", "d"]);
    this.oicP = await this.tryGet(["oic", "p"]);
    const oicRes = (await this.tryGet<OcfLink[] | Rep>(["oic", "res"])) as OcfLink[] | undefined;
    const batch = await s.get(["device", "0"]);
    const list = decodeCbor<unknown[]>(batch.payload);
    const resources = parseDevice0Batch(Array.isArray(list) ? list : []);
    for (const [href, rep] of Object.entries(resources)) this.state.set(href, rep);
    this.deviceTypes = deviceTypesFrom(this.oicD, Array.isArray(oicRes) ? oicRes : undefined);
    this.log("info", `discovered ${this.state.size} resources; types=[${this.deviceTypes.join(",")}]`);
    this.emit("discovered");
  }

  private async tryGet<T = Rep>(path: string[]): Promise<T | undefined> {
    try {
      const r = await this.session!.get(path);
      if (r.code >> 5 !== 2) return undefined;
      return decodeCbor<T>(r.payload);
    } catch {
      return undefined;
    }
  }

  getRep(href: string): Rep | undefined {
    return this.state.get(href);
  }
  getField<T = unknown>(href: string, field: string): T | undefined {
    return this.state.get(href)?.[field] as T | undefined;
  }

  /** Write a CBOR rep to a resource and return the CoAP success class. */
  async write(href: string, rep: Rep): Promise<boolean> {
    const segs = href.split("/").filter(Boolean);
    const r = await this.session!.post(segs, encodeCbor(rep));
    return r.code >> 5 === 2;
  }

  /** Re-read /device/0 and emit 'update' for reps that changed. */
  private async poll(): Promise<void> {
    if (!this.session) return;
    try {
      const batch = await this.session.get(["device", "0"]);
      const list = decodeCbor<unknown[]>(batch.payload);
      const resources = parseDevice0Batch(Array.isArray(list) ? list : []);
      for (const [href, rep] of Object.entries(resources)) {
        const prev = this.state.get(href);
        this.state.set(href, rep);
        if (JSON.stringify(prev) !== JSON.stringify(rep)) this.emit("update", href, rep);
      }
    } catch (e) {
      this.handleDrop(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private startPolling(): void {
    const interval = this.opts.pollIntervalMs ?? 30_000;
    this.pollTimer = setInterval(() => void this.poll(), interval);
  }

  /** Push-worthy state resources to OBSERVE when the config doesn't specify.
   * Only Samsung /vs/0 siblings (the reference's rule: OCF /x/0 never pushes),
   * and only present ones, limited to common state so AV boards aren't poked. */
  private defaultObserveHrefs(): string[] {
    const candidates = [
      "/power/vs/0", "/mode/vs/0", "/temperatures/vs/0", "/temperatures/indoor/vs/0",
      "/humidity/vs/0", "/operational/state/0", "/wind/strength/vs/0", "/filter/airdustfilter/vs/0",
    ];
    const present = candidates.filter((h) => this.state.has(h));
    for (const h of this.state.keys()) if (/^\/door\//.test(h)) present.push(h);
    return present;
  }

  private async startObserving(): Promise<void> {
    const hrefs = this.opts.observeHrefs ?? this.defaultObserveHrefs();
    for (const href of hrefs) {
      const segs = href.split("/").filter(Boolean);
      try {
        const off = await this.session!.observe(segs, (h, payload) => {
          try {
            const rep = decodeCbor<Rep>(payload);
            if (rep && typeof rep === "object") {
              const prev = this.state.get(h);
              this.state.set(h, rep);
              // The registration response seeds the same value we already have;
              // only a genuine change is an update (also dedupes poll vs push).
              if (JSON.stringify(prev) !== JSON.stringify(rep)) this.emit("update", h, rep);
            }
          } catch {
            /* ignore malformed notification */
          }
        });
        this.unobserve.push(off);
      } catch (e) {
        this.log("debug", `observe ${href} failed: ${(e as Error).message}`);
      }
    }
  }

  private draining = false;
  private handleDrop(err: Error): void {
    if (!this.running || this.draining) return; // single-flight: a dropped
    this.draining = true; // session rejects in-flight requests, whose catch
    this.teardownSession(); // would otherwise re-enter handleDrop and open
    this.emit("offline", err); // several concurrent reconnects.
    this.scheduleReconnect();
  }

  private teardownSession(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const off of this.unobserve.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    void this.transport?.close();
    this.session = undefined;
    this.transport = undefined;
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.log("info", `reconnect in ${delay}ms`);
    setTimeout(() => {
      if (!this.running) return;
      // Clear the single-flight drop guard BEFORE retrying, so a failed retry's
      // handleDrop can schedule the next one (otherwise reconnection dies after
      // the first failed attempt). The guard still coalesces the burst of
      // in-flight-request rejections at the moment of a drop.
      this.draining = false;
      // Re-resolve the port: a power cycle can move the appliance's DTLS port.
      const reconnect = async () => {
        if (this.opts.resolvePort) {
          try {
            const p = await this.opts.resolvePort();
            if (p && p !== this.currentPort) {
              this.log("info", `secure port changed to ${p}`);
              this.currentPort = p;
            }
          } catch {
            /* keep the last known port */
          }
        }
        await this.connectAndDiscover();
      };
      reconnect().catch((e) => this.handleDrop(e instanceof Error ? e : new Error(String(e))));
    }, delay);
  }

  async close(): Promise<void> {
    this.running = false;
    this.teardownSession();
  }
}
