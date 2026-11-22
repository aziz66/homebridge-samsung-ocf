/**
 * CoAP request/response session over a DTLS datagram link.
 *
 * Mirrors the wire semantics the reference library established against real
 * Samsung firmware (smartthings_local/protocol/dtls_session.py header):
 *  - Correlate replies by TOKEN, not arrival order; interleaved one-shot and
 *    OBSERVE traffic would otherwise mis-attribute.
 *  - The appliance answers larger requests with ACK then a SEPARATE CON; we
 *    ACK that CON and still resolve the original request by its token.
 *  - Multi-block GET uses the SAME token across every block (token-stable
 *    Block2). A fresh token per block is silently dropped by the server.
 *  - Reads retransmit (RFC 7252 §4.2 backoff); writes send once.
 *  - Requests are paced to avoid bursts the appliance drops under load.
 */
import {
  encode, decode, CoapType, Code, Opt, ContentFormat,
  blockValue, blockFields, pathOptions, queryOptions, bufToUint,
  type CoapMessage, type CoapOption,
} from "./message";

/** The datagram link a session drives (DtlsClientTransport satisfies this). */
export interface DatagramLink {
  send(data: Buffer): Promise<void>;
  onData: (data: Buffer) => void;
  readonly isConnected: boolean;
}

export interface CoapResponse {
  code: number;
  payload: Buffer;
  options: CoapOption[];
}

export type NotificationHandler = (href: string, payload: Buffer, seq: number | null) => void;

export interface CoapSessionOptions {
  rateLimitRps?: number; // default 5/s
  defaultTimeoutMs?: number; // default 8000
  blockSzx?: number; // preferred Block2 SZX (6 = 1024B); server may shrink
  maxBlocks?: number; // safety cap on Block2 blocks (default 128)
}

const CBOR_ACCEPT = Buffer.from([ContentFormat.CBOR]);
const CF_CBOR = Buffer.from([ContentFormat.CBOR]);

interface Pending {
  tokenHex: string;
  resolve: (r: CoapResponse) => void;
  reject: (e: Error) => void;
  // Block2 reassembly state
  path: string[];
  query: string[];
  blocks: Buffer[];
  expectBlock: number;
  szx: number;
  firstOptions?: CoapOption[];
  firstCode?: number;
  // retransmit
  datagram: Buffer;
  retransmit: boolean;
  timer?: NodeJS.Timeout;
  overall?: NodeJS.Timeout;
  acked: boolean;
}

interface Observer {
  tokenHex: string;
  href: string;
  handler: NotificationHandler;
  lastSeq: number | null;
}

const hex = (b: Buffer) => b.toString("hex");

export class CoapSession {
  private readonly link: DatagramLink;
  private readonly rps: number;
  private readonly defaultTimeoutMs: number;
  private readonly szx: number;
  private readonly maxBlocks: number;

  private mid: number;
  private tokenCounter = 1;
  private pending = new Map<string, Pending>();
  private observers = new Map<string, Observer>();
  private lastSendAt = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(link: DatagramLink, opts: CoapSessionOptions = {}) {
    this.link = link;
    this.rps = opts.rateLimitRps ?? 5;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 8000;
    this.szx = opts.blockSzx ?? 6;
    this.maxBlocks = opts.maxBlocks ?? 128;
    this.mid = (Math.random() * 0xffff) & 0xffff;
    link.onData = (buf: Buffer) => this.onDatagram(buf);
  }

  private nextMid(): number {
    this.mid = (this.mid + 1) & 0xffff;
    return this.mid;
  }

  private nextToken(): Buffer {
    const t = Buffer.alloc(2);
    t.writeUInt16BE(this.tokenCounter & 0xffff, 0);
    this.tokenCounter = (this.tokenCounter + 1) & 0xffff;
    if (this.tokenCounter === 0) this.tokenCounter = 1;
    return t;
  }

  /** Pace sends so a burst never exceeds rateLimitRps. */
  private paced(buf: Buffer): Promise<void> {
    const minGap = 1000 / this.rps;
    this.sendChain = this.sendChain.then(async () => {
      const wait = Math.max(0, this.lastSendAt + minGap - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastSendAt = Date.now();
      if (!this.closed) await this.link.send(buf);
    });
    return this.sendChain;
  }

  /** GET a resource href (path segments), Block2-aware. */
  get(path: string[], query: string[] = [], timeoutMs = this.defaultTimeoutMs): Promise<CoapResponse> {
    const token = this.nextToken();
    const options: CoapOption[] = [
      ...pathOptions(path),
      ...queryOptions(query),
      { number: Opt.ACCEPT, value: CBOR_ACCEPT },
    ];
    const msg: CoapMessage = { type: CoapType.CON, code: Code.GET, messageId: this.nextMid(), token, options };
    const datagram = encode(msg);
    return this.track(token, path, query, datagram, true, timeoutMs);
  }

  /** POST (write) a CBOR payload to a resource href. Sent once (no retransmit). */
  post(path: string[], payload: Buffer, timeoutMs = this.defaultTimeoutMs): Promise<CoapResponse> {
    const token = this.nextToken();
    const options: CoapOption[] = [
      ...pathOptions(path),
      { number: Opt.CONTENT_FORMAT, value: CF_CBOR },
    ];
    const msg: CoapMessage = { type: CoapType.CON, code: Code.POST, messageId: this.nextMid(), token, options, payload };
    const datagram = encode(msg);
    return this.track(token, path, [], datagram, false, timeoutMs);
  }

  /** Subscribe to CoAP Observe on a resource. Returns an unsubscribe fn. */
  async observe(path: string[], handler: NotificationHandler, query: string[] = []): Promise<() => void> {
    const token = this.nextToken();
    const href = "/" + path.join("/");
    const options: CoapOption[] = [
      { number: Opt.OBSERVE, value: Buffer.alloc(0) }, // 0 = register
      ...pathOptions(path),
      ...queryOptions(query),
      { number: Opt.ACCEPT, value: CBOR_ACCEPT },
    ];
    const msg: CoapMessage = { type: CoapType.CON, code: Code.GET, messageId: this.nextMid(), token, options };
    this.observers.set(hex(token), { tokenHex: hex(token), href, handler, lastSeq: null });
    await this.paced(encode(msg));
    return () => {
      const t = Buffer.from(token);
      const dereg: CoapMessage = {
        type: CoapType.CON, code: Code.GET, messageId: this.nextMid(), token: t,
        options: [{ number: Opt.OBSERVE, value: Buffer.from([1]) }, ...pathOptions(path), ...queryOptions(query), { number: Opt.ACCEPT, value: CBOR_ACCEPT }],
      };
      this.observers.delete(hex(t));
      void this.paced(encode(dereg)).catch(() => {});
    };
  }

  private track(token: Buffer, path: string[], query: string[], datagram: Buffer, retransmit: boolean, timeoutMs: number): Promise<CoapResponse> {
    const tokenHex = hex(token);
    return new Promise<CoapResponse>((resolve, reject) => {
      const p: Pending = {
        tokenHex, resolve, reject, path, query, blocks: [], expectBlock: 0,
        szx: this.szx, datagram, retransmit, acked: false,
      };
      this.pending.set(tokenHex, p);
      p.overall = setTimeout(() => this.fail(tokenHex, new Error(`CoAP timeout after ${timeoutMs}ms for /${path.join("/")}`)), timeoutMs);
      if (retransmit) this.scheduleRetransmit(p, 2000, 0);
      this.paced(datagram).catch((e) => this.fail(tokenHex, e instanceof Error ? e : new Error(String(e))));
    });
  }

  private scheduleRetransmit(p: Pending, delay: number, count: number): void {
    // RFC 7252 §4.2: up to 4 retransmissions, doubling backoff. Stop once ACKed.
    if (count >= 4) return;
    p.timer = setTimeout(() => {
      if (this.closed || !this.pending.has(p.tokenHex) || p.acked) return;
      void this.paced(p.datagram).catch(() => {});
      this.scheduleRetransmit(p, delay * 2, count + 1);
    }, delay);
  }

  private fail(tokenHex: string, err: Error): void {
    const p = this.pending.get(tokenHex);
    if (!p) return;
    this.pending.delete(tokenHex);
    if (p.timer) clearTimeout(p.timer);
    if (p.overall) clearTimeout(p.overall);
    p.reject(err);
  }

  private settle(p: Pending, code: number, payload: Buffer, options: CoapOption[]): void {
    this.pending.delete(p.tokenHex);
    if (p.timer) clearTimeout(p.timer);
    if (p.overall) clearTimeout(p.overall);
    p.resolve({ code, payload, options });
  }

  private option(options: CoapOption[], number: number): Buffer | undefined {
    return options.find((o) => o.number === number)?.value;
  }

  private onDatagram(buf: Buffer): void {
    let msg: CoapMessage;
    try {
      msg = decode(buf);
    } catch {
      return; // ignore malformed datagrams
    }
    const tokenHex = hex(msg.token);

    // Empty ACK for one of our CONs: the real response arrives separately.
    if (msg.type === CoapType.ACK && msg.code === Code.EMPTY) {
      const p = this.pending.get(tokenHex);
      if (p) {
        p.acked = true;
        if (p.timer) clearTimeout(p.timer); // stop retransmit; await separate CON
      }
      return;
    }

    // A CON carrying data (separate response or an OBSERVE notification): ACK it.
    if (msg.type === CoapType.CON) {
      void this.paced(encode({ type: CoapType.ACK, code: Code.EMPTY, messageId: msg.messageId, token: Buffer.alloc(0), options: [] })).catch(() => {});
    }

    // OBSERVE notification?
    const obs = this.observers.get(tokenHex);
    if (obs && this.option(msg.options, Opt.OBSERVE) !== undefined) {
      const seqBuf = this.option(msg.options, Opt.OBSERVE)!;
      const seq = seqBuf.length ? bufToUint(seqBuf) : null;
      if (seq !== null && obs.lastSeq !== null && !seqNewer(obs.lastSeq, seq)) return; // stale/dup
      if (seq !== null) obs.lastSeq = seq;
      obs.handler(obs.href, msg.payload ?? Buffer.alloc(0), seq);
      return;
    }

    // Ordinary response matched by token.
    const p = this.pending.get(tokenHex);
    if (!p) return;
    p.acked = true;
    if (p.timer) clearTimeout(p.timer);

    const block2 = this.option(msg.options, Opt.BLOCK2);
    if (p.firstCode === undefined) {
      p.firstCode = msg.code;
      p.firstOptions = msg.options;
    }
    if (block2) {
      const { num, more, szx } = blockFields(block2);
      p.szx = szx;
      p.blocks[num] = msg.payload ?? Buffer.alloc(0);
      if (more) {
        if (num + 1 >= this.maxBlocks) return this.fail(p.tokenHex, new Error("Block2 exceeded maxBlocks"));
        // request the next block with the SAME token (token-stable Block2)
        const next: CoapMessage = {
          type: CoapType.CON, code: Code.GET, messageId: this.nextMid(),
          token: Buffer.from(p.tokenHex, "hex"),
          options: [...pathOptions(p.path), ...queryOptions(p.query),
            { number: Opt.ACCEPT, value: CBOR_ACCEPT },
            { number: Opt.BLOCK2, value: blockValue(num + 1, false, szx) }],
        };
        p.datagram = encode(next);
        p.acked = false;
        if (p.timer) clearTimeout(p.timer);
        if (p.retransmit) this.scheduleRetransmit(p, 2000, 0);
        void this.paced(p.datagram).catch(() => {});
        return;
      }
      // last block: concatenate
      const full = Buffer.concat(p.blocks.filter((b) => b !== undefined));
      return this.settle(p, p.firstCode!, full, p.firstOptions!);
    }
    // single-block response
    this.settle(p, msg.code, msg.payload ?? Buffer.alloc(0), msg.options);
  }

  close(): void {
    this.closed = true;
    for (const tokenHex of [...this.pending.keys()]) this.fail(tokenHex, new Error("session closed"));
    this.observers.clear();
  }
}

/** RFC 7641 §3.4: compare 24-bit sequence numbers with wraparound (newer?). */
function seqNewer(oldSeq: number, newSeq: number): boolean {
  const T = 1 << 23;
  return (oldSeq < newSeq && newSeq - oldSeq < T) || (oldSeq > newSeq && oldSeq - newSeq > T);
}
