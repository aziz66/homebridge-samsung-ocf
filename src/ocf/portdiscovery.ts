/**
 * Local OCF secure-port discovery (no DTLS). An appliance's coaps (DTLS) port
 * varies per unit and after a power cycle; it advertises it in its plaintext
 * /oic/res directory on UDP 5683 as a "coaps://host:PORT" endpoint. This sends
 * a plaintext CoAP GET /oic/res?rt=oic.r.doxm and parses the secure port(s).
 *
 * Mirrors the reference's discover_ocf_secure_ports (unicast form). It only
 * reads a public directory; it authenticates nothing.
 */
import { createSocket } from "node:dgram";
import { encode, decode, CoapType, Code, Opt, ContentFormat, pathOptions, queryOptions } from "../coap/message";
import { decodeCbor } from "./cbor";

const DISCOVERY_PORT = 5683;

interface Link {
  href?: string;
  rt?: string[];
  eps?: Array<{ ep?: string }>;
  p?: unknown;
}

/** Parse coaps ports out of an /oic/res link array. */
export function securePortsFromLinks(links: unknown): number[] {
  const ports = new Set<number>();
  const arr = Array.isArray(links) ? (links as Link[]) : [];
  for (const link of arr) {
    for (const ep of link.eps ?? []) {
      const m = typeof ep.ep === "string" && /^coaps:\/\/.*:(\d+)$/.exec(ep.ep);
      if (m) {
        const port = Number(m[1]);
        if (port > 0 && port < 65536) ports.add(port);
      }
    }
  }
  return [...ports];
}

export interface DiscoverOptions {
  timeoutMs?: number;
  discoveryPort?: number;
}

/**
 * Discover an appliance's DTLS secure port(s) by reading its plaintext
 * /oic/res. Returns candidate ports (unauthenticated — still probe/verify
 * before trusting). Resolves [] if nothing answers in time.
 */
export function discoverSecurePorts(host: string, opts: DiscoverOptions = {}): Promise<number[]> {
  const port = opts.discoveryPort ?? DISCOVERY_PORT;
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const found = new Set<number>();
    const token = Buffer.from([0x0d, 0x15]);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve([...found]);
    };
    sock.on("message", (msg) => {
      try {
        const m = decode(msg);
        if (m.token.equals(token) && m.code >> 5 === 2) {
          for (const p of securePortsFromLinks(decodeCbor(m.payload ?? Buffer.alloc(0)))) found.add(p);
        }
      } catch {
        /* ignore malformed */
      }
    });
    sock.on("error", finish);
    sock.bind(0, () => {
      const req = encode({
        type: CoapType.NON,
        code: Code.GET,
        messageId: Math.floor(Math.random() * 0xffff),
        token,
        options: [
          ...pathOptions(["oic", "res"]),
          ...queryOptions(["rt=oic.r.doxm"]),
          { number: Opt.ACCEPT, value: Buffer.from([ContentFormat.CBOR]) },
        ],
      });
      sock.send(req, port, host, () => {});
    });
    setTimeout(finish, timeoutMs);
  });
}
