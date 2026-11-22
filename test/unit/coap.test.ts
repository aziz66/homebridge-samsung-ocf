import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  encode, decode, CoapType, Code, Opt, ContentFormat,
  blockValue, blockFields, pathOptions, queryOptions, uintToBuf,
} from "../../src/coap/message";

const G = JSON.parse(readFileSync(join(__dirname, "coap-goldens.json"), "utf8"));
const hex = (b: Buffer) => b.toString("hex");
const CBOR = Buffer.from([ContentFormat.CBOR]); // 0x3c

describe("CoAP codec vs Python smartthings_local.coap goldens", () => {
  it("get_oic_res: CON GET /oic/res, no Accept", () => {
    const b = encode({ type: CoapType.CON, code: Code.GET, messageId: 0x1234,
      token: Buffer.from([0x01]), options: pathOptions(["oic", "res"]) });
    expect(hex(b)).toBe(G.vectors.get_oic_res);
  });

  it("get_doxm_accept: Uri-Query + Accept=CBOR", () => {
    const b = encode({ type: CoapType.CON, code: Code.GET, messageId: 0xabcd,
      token: Buffer.from([0xaa, 0xbb]),
      options: [...pathOptions(["oic", "res"]), ...queryOptions(["rt=oic.r.doxm"]),
        { number: Opt.ACCEPT, value: CBOR }] });
    expect(hex(b)).toBe(G.vectors.get_doxm_accept);
  });

  it("get_block2: Block2 option num=2 szx=6", () => {
    const b = encode({ type: CoapType.CON, code: Code.GET, messageId: 0x0001,
      token: Buffer.from([0x07]),
      options: [...pathOptions(["device", "0"]), { number: Opt.ACCEPT, value: CBOR },
        { number: Opt.BLOCK2, value: blockValue(2, false, 6) }] });
    expect(hex(b)).toBe(G.vectors.get_block2);
  });

  it("post_mode: POST with Content-Format + CBOR payload", () => {
    const b = encode({ type: CoapType.CON, code: Code.POST, messageId: 0x5555,
      token: Buffer.from([0x09]),
      options: [...pathOptions(["mode", "vs", "0"]), { number: Opt.CONTENT_FORMAT, value: CBOR }],
      payload: Buffer.from("a1781b782e636f6d2e73616d73756e672e64612e6d6f64656448656174", "hex") });
    expect(hex(b)).toBe(G.vectors.post_mode);
  });

  it("empty_ack", () => {
    const b = encode({ type: CoapType.ACK, code: Code.EMPTY, messageId: 0x1234,
      token: Buffer.alloc(0), options: [] });
    expect(hex(b)).toBe(G.vectors.empty_ack);
  });

  it("observe_register: Observe(6) empty + path + Accept, option sort correct", () => {
    const b = encode({ type: CoapType.CON, code: Code.GET, messageId: 0x0abc,
      token: Buffer.from([0x11]),
      options: [{ number: Opt.OBSERVE, value: Buffer.alloc(0) },
        ...pathOptions(["mode", "vs", "0"]), { number: Opt.ACCEPT, value: CBOR }] });
    expect(hex(b)).toBe(G.vectors.observe_register);
  });

  it("ext_delta: Size1(60) forces extended option delta", () => {
    const b = encode({ type: CoapType.NON, code: Code.GET, messageId: 0x7777,
      token: Buffer.alloc(0),
      options: [{ number: Opt.URI_PATH, value: Buffer.from("a") },
        { number: Opt.SIZE1, value: Buffer.from([5]) }] });
    expect(hex(b)).toBe(G.vectors.ext_delta);
  });
});

describe("Block option values vs Python block_value", () => {
  for (const [key, expected] of Object.entries(G.blocks) as [string, string][]) {
    it(`block_value ${key}`, () => {
      const m = key.match(/\((\d+), (\d+), (\d+)\)/)!;
      const [num, more, szx] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const v = blockValue(num, more === 1, szx);
      expect(hex(v)).toBe(expected);
      const f = blockFields(v);
      expect([f.num, f.more ? 1 : 0, f.szx]).toEqual([num, more, szx]);
    });
  }
});

describe("round-trip", () => {
  it("decode(encode(x)) preserves fields for every golden", () => {
    for (const h of Object.values(G.vectors) as string[]) {
      const buf = Buffer.from(h, "hex");
      const m = decode(buf);
      expect(hex(encode(m))).toBe(h);
    }
  });
  it("uintToBuf minimal-length", () => {
    expect(hex(uintToBuf(0))).toBe("");
    expect(hex(uintToBuf(5))).toBe("05");
    expect(hex(uintToBuf(300))).toBe("012c");
  });
  it("rejects bad version and truncation", () => {
    expect(() => decode(Buffer.from([0x81, 0, 0, 0]))).toThrow();
    expect(() => decode(Buffer.from([0x41]))).toThrow();
  });
});
