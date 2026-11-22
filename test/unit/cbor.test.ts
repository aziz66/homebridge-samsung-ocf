import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCbor, decodeCbor } from "../../src/ocf/cbor";

const G = JSON.parse(readFileSync(join(__dirname, "cbor-goldens.json"), "utf8"));
const hex = (b: Buffer) => b.toString("hex");

describe("CBOR encoder byte-compatibility with Python cbor2", () => {
  // The Samsung write fields this plugin emits are string/int/bool maps.
  const cases: Record<string, unknown> = {
    power_on: { "x.com.samsung.da.power": "On" },
    mode_cool: { "x.com.samsung.da.modes": ["Cool"] },
    temp_desired: { "x.com.samsung.da.items": [{ "x.com.samsung.da.id": "0", "x.com.samsung.da.desired": "25" }] },
    kidslock: { "x.com.samsung.da.kidsLock": "Off" },
    nums: { a: 1, b: 2.5, c: true, d: -3 },
  };
  for (const [name, value] of Object.entries(cases)) {
    it(`${name} encodes to the same bytes as cbor2`, () => {
      expect(hex(encodeCbor(value))).toBe(G[name]);
    });
    it(`${name} round-trips`, () => {
      expect(decodeCbor(encodeCbor(value))).toEqual(value);
    });
  }
  it("decodes cbor2's own bytes back to the original value", () => {
    expect(decodeCbor(Buffer.from(G.power_on, "hex"))).toEqual({ "x.com.samsung.da.power": "On" });
    expect(decodeCbor(Buffer.from(G.temp_desired, "hex"))).toEqual({
      "x.com.samsung.da.items": [{ "x.com.samsung.da.id": "0", "x.com.samsung.da.desired": "25" }],
    });
  });
});
