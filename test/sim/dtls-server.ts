/**
 * In-process DTLS server for the appliance simulator.
 *
 * This is a TEST FIXTURE, not an interop oracle: it uses werift on both ends,
 * so it exercises the plugin's CoAP/OCF/registry/HomeKit layers against a
 * working DTLS peer. Foreign-peer wire interop is proven separately against
 * OpenSSL in research/interop/ (see research/DTLS-WERIFT-FINDINGS.md).
 *
 * It presents an ECDSA P-256 certificate (as the appliance does, for the
 * ECDHE-ECDSA cipher) and requests the client certificate.
 */
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { DtlsServer } from "werift-dtls/lib/dtls/src/index.js";

const SIG_ECDSA = { hash: 4, signature: 3 };

export interface SimDtlsServer {
  port: number;
  /** Set by the owner: handle one decrypted datagram from the client. */
  onData: (data: Buffer) => void;
  /** Send an (encrypted) datagram to the connected client. */
  send: (data: Buffer) => Promise<void>;
  connected: Promise<void>;
  close: () => Promise<void>;
}

/** Start a one-peer DTLS server on an ephemeral UDP port. */
export async function startSimDtlsServer(cert: string, key: string, fixedPort = 0): Promise<SimDtlsServer> {
  const sock: Socket = createSocket("udp4");
  let peer: RemoteInfo | undefined;
  let server: InstanceType<typeof DtlsServer> | undefined;
  let onDataCb: (d: Buffer) => void = () => {};
  let resolveConnected!: () => void;
  const connected = new Promise<void>((r) => (resolveConnected = r));

  const backing = {
    type: "udp",
    address: { address: "0.0.0.0", family: "IPv4", port: 0 },
    closed: false,
    onData: (_d: Buffer, _a: [string, number]) => {},
    send: (data: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        if (!peer) return resolve();
        sock.send(data, peer.port, peer.address, (e) => (e ? reject(e) : resolve()));
      }),
    close: async (): Promise<void> => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    },
  };

  sock.on("message", (msg, rinfo) => {
    peer = rinfo;
    backing.onData(msg, [rinfo.address, rinfo.port]);
  });

  await new Promise<void>((resolve, reject) => { sock.once("error", reject); sock.bind(fixedPort, () => resolve()); });
  const port = sock.address().port;

  server = new DtlsServer({
    transport: backing as never,
    cert,
    key,
    certificateRequest: true,
    signatureHash: SIG_ECDSA,
  });
  server.onConnect.subscribe(() => resolveConnected());
  server.onData.subscribe((buf: Buffer) => onDataCb(buf));

  return {
    port,
    set onData(cb: (d: Buffer) => void) {
      onDataCb = cb;
    },
    get onData() {
      return onDataCb;
    },
    send: (data: Buffer) => server!.send(data),
    connected,
    close: async () => {
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      await backing.close();
    },
  };
}
