/**
 * Simulated Samsung OCF appliance (TEST FIXTURE).
 *
 * Serves CoAP/OCF over the in-process DTLS peer (test/sim/dtls-server.ts) from
 * a captured device fixture: /oic/res, /oic/d, the /device/0 batch (Block2 when
 * large), individual resources, POST writes, and Observe pushes.
 *
 * HONESTY: read behaviour replays REAL captures. Write and Observe behaviour is
 * MODELLED (the fixtures are state snapshots; they carry no write responses).
 * Foreign-peer DTLS interop is proven separately against OpenSSL.
 */
import {
  decode, encode, CoapType, Opt, ContentFormat, mkCode, blockValue, blockFields,
  bufToUint, type CoapMessage, type CoapOption,
} from "../../src/coap/message";
import { encodeCbor } from "../../src/ocf/cbor";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import { startSimDtlsServer, type SimDtlsServer } from "./dtls-server";

const C_CONTENT = mkCode(2, 5); // 2.05
const C_CHANGED = mkCode(2, 4); // 2.04
const C_NOTFOUND = mkCode(4, 4); // 4.04
const C_BADREQ = mkCode(4, 0); // 4.00

export interface SimApplianceState {
  /** {href: rep} resource map (from parse of the fixture's device0 list). */
  resources: Record<string, Record<string, unknown>>;
  /** the raw /device/0 batch list (first element devcol, then {href,rep}). */
  device0: unknown[];
  /** optional /oic/res link array; synthesized from hrefs if absent. */
  oicRes?: unknown[];
}

/** Parse a fixture's device0 list into {href: rep} (re-exported canonical impl). */
export const parseDevice0 = parseDevice0Batch;

export class SimAppliance {
  private server?: SimDtlsServer;
  private observers = new Map<string, { href: string; token: Buffer; seq: number }>();
  private postLog: { href: string; payload: Buffer }[] = [];
  /** Turn on to answer large reads via a separate CON instead of piggyback. */
  separateResponses = false;

  constructor(private state: SimApplianceState) {}

  get writes(): { href: string; payload: Buffer }[] {
    return this.postLog;
  }
  get port(): number {
    return this.server!.port;
  }

  async start(cert: string, key: string, fixedPort = 0): Promise<void> {
    this.server = await startSimDtlsServer(cert, key, fixedPort);
    this.server.onData = (buf) => this.handle(buf);
  }
  async close(): Promise<void> {
    await this.server?.close();
  }
  get connected(): Promise<void> {
    return this.server!.connected;
  }

  private send(datagram: Buffer): void {
    void this.server!.send(datagram);
  }

  private hrefOf(msg: CoapMessage): string {
    const segs = msg.options.filter((o) => o.number === Opt.URI_PATH).map((o) => o.value.toString("utf8"));
    return "/" + segs.join("/");
  }
  private queryOf(msg: CoapMessage): string[] {
    return msg.options.filter((o) => o.number === Opt.URI_QUERY).map((o) => o.value.toString("utf8"));
  }

  /** Build the payload for a resource href, or undefined for 4.04. */
  private payloadFor(href: string, query: string[]): Buffer | undefined {
    if (href === "/oic/res") {
      const links = this.state.oicRes ?? this.synthOicRes();
      const filtered = query.some((q) => q.startsWith("rt="))
        ? links.filter((l) => matchesRt(l, query))
        : links;
      return encodeCbor(filtered);
    }
    if (href === "/device/0") return encodeCbor(this.state.device0);
    const rep = this.state.resources[href];
    if (rep) return encodeCbor(rep);
    if (href === "/oic/d" && this.state.resources["/oic/d"]) return encodeCbor(this.state.resources["/oic/d"]);
    return undefined;
  }

  private synthOicRes(): unknown[] {
    return Object.keys(this.state.resources).map((href) => ({
      href,
      rt: (this.state.resources[href]["rt"] as string[]) ?? [],
      if: ["oic.if.baseline", "oic.if.a"],
    }));
  }

  private handle(buf: Buffer): void {
    let msg: CoapMessage;
    try {
      msg = decode(buf);
    } catch {
      return;
    }
    // ACK from the client for our separate CON / notification — nothing to do.
    if (msg.type === CoapType.ACK) return;

    const href = this.hrefOf(msg);
    const query = this.queryOf(msg);
    const isGet = msg.code === 1;
    const isPost = msg.code === 2;

    // OBSERVE register/deregister
    const obsOpt = msg.options.find((o) => o.number === Opt.OBSERVE);
    if (isGet && obsOpt) {
      if (obsOpt.value.length && bufToUint(obsOpt.value) === 1) {
        this.observers.delete(href);
      } else {
        this.observers.set(href, { href, token: msg.token, seq: 2 });
      }
      // seed with current value, Observe seq=1
      const payload = this.payloadFor(href, query) ?? Buffer.alloc(0);
      this.send(encode({
        type: CoapType.ACK, code: payload.length ? C_CONTENT : C_NOTFOUND, messageId: msg.messageId, token: msg.token,
        options: [{ number: Opt.OBSERVE, value: Buffer.from([1]) }, { number: Opt.CONTENT_FORMAT, value: Buffer.from([ContentFormat.CBOR]) }],
        payload,
      }));
      return;
    }

    if (isPost) {
      this.postLog.push({ href, payload: msg.payload ?? Buffer.alloc(0) });
      // modelled write: merge CBOR into the stored rep so a readback reflects it
      this.send(encode({ type: CoapType.ACK, code: C_CHANGED, messageId: msg.messageId, token: msg.token, options: [] }));
      return;
    }

    if (isGet) {
      const full = this.payloadFor(href, query);
      if (full === undefined) {
        this.send(encode({ type: CoapType.ACK, code: C_NOTFOUND, messageId: msg.messageId, token: msg.token, options: [] }));
        return;
      }
      this.respondBlockwise(msg, full);
      return;
    }
    // unsupported method
    this.send(encode({ type: CoapType.ACK, code: C_BADREQ, messageId: msg.messageId, token: msg.token, options: [] }));
  }

  private respondBlockwise(msg: CoapMessage, full: Buffer): void {
    const reqBlock = msg.options.find((o) => o.number === Opt.BLOCK2);
    const szx = reqBlock && reqBlock.value.length ? blockFields(reqBlock.value).szx : 6;
    const blockSize = 1 << (szx + 4);
    const cfOpt: CoapOption = { number: Opt.CONTENT_FORMAT, value: Buffer.from([ContentFormat.CBOR]) };

    if (full.length <= blockSize && !reqBlock) {
      if (this.separateResponses) {
        // Empty ACK now, then the data as a separate CON (as real firmware does
        // for larger answers). The client must ACK the CON and match by token.
        this.send(encode({ type: CoapType.ACK, code: 0, messageId: msg.messageId, token: Buffer.alloc(0), options: [] }));
        setTimeout(() => this.send(encode({
          type: CoapType.CON, code: C_CONTENT, messageId: Math.floor(Math.random() * 0xffff),
          token: msg.token, options: [cfOpt], payload: full,
        })), 15);
        return;
      }
      this.send(encode({ type: CoapType.ACK, code: C_CONTENT, messageId: msg.messageId, token: msg.token, options: [cfOpt], payload: full }));
      return;
    }
    const num = reqBlock && reqBlock.value.length ? blockFields(reqBlock.value).num : 0;
    const start = num * blockSize;
    const chunk = full.subarray(start, start + blockSize);
    const more = start + blockSize < full.length;
    this.send(encode({
      type: CoapType.ACK, code: C_CONTENT, messageId: msg.messageId, token: msg.token,
      options: [cfOpt, { number: Opt.BLOCK2, value: blockValue(num, more, szx) }],
      payload: chunk.length ? Buffer.from(chunk) : undefined,
    }));
  }

  /** Push an OBSERVE notification for a resource whose rep changed. */
  pushNotification(href: string, rep: Record<string, unknown>): void {
    const o = this.observers.get(href);
    if (!o) return;
    this.state.resources[href] = rep;
    const seq = o.seq++;
    this.send(encode({
      type: CoapType.CON, code: C_CONTENT, messageId: Math.floor(Math.random() * 0xffff), token: o.token,
      options: [{ number: Opt.OBSERVE, value: seqBytes(seq) }, { number: Opt.CONTENT_FORMAT, value: Buffer.from([ContentFormat.CBOR]) }],
      payload: encodeCbor(rep),
    }));
  }
}

function matchesRt(link: unknown, query: string[]): boolean {
  const wanted = query.filter((q) => q.startsWith("rt=")).map((q) => q.slice(3));
  const rts = (link as { rt?: string[] })?.rt ?? [];
  return wanted.some((w) => rts.includes(w));
}
function seqBytes(seq: number): Buffer {
  if (seq <= 0xff) return Buffer.from([seq]);
  const b = Buffer.alloc(2);
  b.writeUInt16BE(seq & 0xffff, 0);
  return b;
}
