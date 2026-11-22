/**
 * DTLS 1.2 client transport for Samsung OCF appliances, over werift-dtls.
 *
 * Verified (hardware-free) against an independent OpenSSL DTLS server: this
 * config completes an ECDHE-ECDSA-AES128-GCM-SHA256 / P-256 handshake with a
 * client certificate and exchanges application data. See
 * research/DTLS-WERIFT-FINDINGS.md. The appliance's own firmware is NOT
 * verified here — see that document's limitations.
 */
import { createSocket, type Socket } from "node:dgram";
// werift-dtls@0.5.8's published "main" is missing; the real entry is this subpath.
// Isolated here so the quirk lives in exactly one module.
import { DtlsClient } from "werift-dtls/lib/dtls/src/index.js";

export type SignatureHash = { hash: number; signature: number };
/** sha256 + RSA — for an RSA-2048 client certificate (the reference default). */
export const SIG_RSA: SignatureHash = { hash: 4, signature: 1 };
/** sha256 + ECDSA — for an ECDSA P-256 client certificate. */
export const SIG_ECDSA: SignatureHash = { hash: 4, signature: 3 };

type Addr = [string, number];

/** Minimal werift Transport backed by a connected-by-send UDP socket. */
class UdpBacking {
  readonly type = "udp";
  readonly address = { address: "0.0.0.0", family: "IPv4", port: 0 };
  closed = false;
  onData: (data: Buffer, addr: Addr) => void = () => {};
  constructor(
    private readonly sock: Socket,
    private readonly host: string,
    private readonly port: number,
  ) {
    sock.on("message", (msg) => {
      try {
        this.onData(msg, [this.host, this.port]);
      } catch {
        /* werift logs its own handler errors; never let one kill the socket */
      }
    });
  }
  send = (data: Buffer): Promise<void> =>
    new Promise((resolve) => {
      // Resolve (never reject) once closed, and treat a post-close socket error
      // as a no-op: werift's handshake retransmit timers can fire a send after
      // teardown, and an unhandled rejection there would crash the bridge.
      if (this.closed) return resolve();
      try {
        this.sock.send(data, this.port, this.host, () => resolve());
      } catch {
        resolve();
      }
    });
  close = async (): Promise<void> => {
    this.closed = true;
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  };
}

export interface DtlsTransportOptions {
  host: string;
  port: number;
  /** PEM client certificate (leaf). */
  cert: string;
  /** PEM client private key (PKCS#8 recommended). */
  key: string;
  /** Signature/hash for the client cert. Defaults to RSA+sha256. */
  signatureHash?: SignatureHash;
  /** Handshake deadline. werift's connect() never times out on its own. */
  connectTimeoutMs?: number;
}

/**
 * One DTLS session to one appliance. Datagram in/out only; CoAP framing is a
 * layer above. Lifecycle: connect() → send()/onData → close(). Not reusable
 * after close(); make a new instance to reconnect.
 */
export class DtlsClientTransport {
  private client?: InstanceType<typeof DtlsClient>;
  private backing?: UdpBacking;
  private connected = false;
  private closedFlag = false;

  /** Application data from the appliance (decrypted CoAP datagrams). */
  onData: (data: Buffer) => void = () => {};
  /** Fires when the peer sends a close/alert. Silent UDP drops need a keepalive. */
  onClose: () => void = () => {};
  /** Transport-level errors after connect. */
  onError: (err: Error) => void = () => {};

  constructor(private readonly opts: DtlsTransportOptions) {}

  get isConnected(): boolean {
    return this.connected && !this.closedFlag;
  }

  async connect(): Promise<void> {
    if (this.connected) throw new Error("already connected");
    if (this.closedFlag) throw new Error("transport closed; make a new instance");
    const timeoutMs = this.opts.connectTimeoutMs ?? 12_000;
    const sock = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, () => {
        sock.off("error", reject);
        resolve();
      });
    });
    const backing = new UdpBacking(sock, this.opts.host, this.opts.port);
    this.backing = backing;
    const client = new DtlsClient({
      transport: backing as never,
      cert: this.opts.cert,
      key: this.opts.key,
      certificateRequest: true,
      signatureHash: (this.opts.signatureHash ?? SIG_RSA) as never,
    });
    this.client = client;

    client.onData.subscribe((buf: Buffer) => {
      if (!this.closedFlag) this.onData(buf);
    });
    client.onClose.subscribe(() => {
      if (!this.closedFlag) {
        this.closedFlag = true;
        this.connected = false;
        this.onClose();
      }
    });
    client.onError.subscribe((e: unknown) => {
      if (!this.closedFlag) this.onError(e instanceof Error ? e : new Error(String(e)));
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.close();
        reject(new Error(`DTLS handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      client.onConnect.subscribe(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });
      client.onError.subscribe((e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
      client.connect().catch(() => {
        /* connect() only sends flight 1; real failures arrive via onError/timeout */
      });
    });
  }

  async send(data: Buffer): Promise<void> {
    if (!this.client || !this.connected) throw new Error("not connected");
    await this.client.send(data);
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.connected = false;
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.backing?.close();
    } catch {
      /* ignore */
    }
  }
}
