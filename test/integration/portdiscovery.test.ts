import { describe, it, expect, afterEach } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import { decode, encode, CoapType, Opt, ContentFormat, mkCode } from "../../src/coap/message";
import { encodeCbor } from "../../src/ocf/cbor";
import { discoverSecurePorts, securePortsFromLinks } from "../../src/ocf/portdiscovery";

let responder: Socket | undefined;
afterEach(() => { try { responder?.close(); } catch { /* */ } responder = undefined; });

describe("OCF secure-port discovery", () => {
  it("parses coaps ports from /oic/res links", () => {
    const links = [
      { href: "/oic/d", rt: ["oic.wk.d"], eps: [{ ep: "coap://192.0.2.5:5683" }] },
      { href: "/oic/sec/doxm", rt: ["oic.r.doxm"], eps: [{ ep: "coaps://192.0.2.5:49231" }, { ep: "coap://192.0.2.5:5683" }] },
    ];
    expect(securePortsFromLinks(links)).toEqual([49231]);
  });

  it("discovers the secure port from a plaintext responder", async () => {
    responder = createSocket("udp4");
    const SECURE = 49777;
    responder.on("message", (msg, rinfo) => {
      const req = decode(msg);
      const links = [{ href: "/oic/sec/doxm", rt: ["oic.r.doxm"], eps: [{ ep: `coaps://127.0.0.1:${SECURE}` }] }];
      const reply = encode({
        type: CoapType.NON, code: mkCode(2, 5), messageId: req.messageId, token: req.token,
        options: [{ number: Opt.CONTENT_FORMAT, value: Buffer.from([ContentFormat.CBOR]) }],
        payload: encodeCbor(links),
      });
      responder!.send(reply, rinfo.port, rinfo.address, () => {});
    });
    const port = await new Promise<number>((r) => responder!.bind(0, () => r(responder!.address().port)));
    const found = await discoverSecurePorts("127.0.0.1", { discoveryPort: port, timeoutMs: 2000 });
    expect(found).toContain(SECURE);
  });

  it("resolves [] when nothing answers", async () => {
    const found = await discoverSecurePorts("127.0.0.1", { discoveryPort: 1, timeoutMs: 500 });
    expect(found).toEqual([]);
  });
});
