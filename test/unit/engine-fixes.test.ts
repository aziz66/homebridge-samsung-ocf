import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch, deviceTypesFrom } from "../../src/ocf/discovery";
import type { StateMap, WriteOp } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
const ORACLE = JSON.parse(readFileSync(join(__dirname, "..", "..", "research", "oracle", "oracle.json"), "utf8")).fixtures;
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}
const one = (op: WriteOp | WriteOp[] | null): WriteOp => (Array.isArray(op) ? op[0] : op!) as WriteOp;

describe("power reads/writes the correct OCF-vs-vendor field", () => {
  it("dryer binds OCF /power/0 {value} and reports off, writing {value}", () => {
    const s = stateOf("dryer"); // /power/0 {value:false}
    const prim = buildServices(s, ["oic.d.dryer"]).services.find((x) => x.primary)!;
    expect(prim.chars.find((c) => c.char === "Active")!.get!(s)).toBe(0); // was wrongly 1 before the fix
    const w = one(prim.chars.find((c) => c.char === "Active")!.set!(1, s));
    expect(w).toMatchObject({ href: "/power/0", rep: { value: true } }); // OCF field, not x.com.samsung.da.power
  });
  it("AC with only vendor /power/vs/0 still uses the vendor field", () => {
    const s = stateOf("airconditioner_tp1x_da_ac_rac_01011");
    const hc = buildServices(s, []).services.find((x) => x.service === "HeaterCooler")!;
    expect(one(hc.chars.find((c) => c.char === "Active")!.set!(1, s))).toMatchObject({ href: "/power/vs/0", rep: { "x.com.samsung.da.power": "On" } });
  });
});

describe("laundry RemainingDuration parses HH:MM:SS (not a bare number)", () => {
  it("every laundry fixture yields a sane 0..14400 duration, non-zero where the device has time left", () => {
    let sawNonZero = false;
    for (const f of readdirSync(FIX).filter((n) => n.endsWith("_device.json"))) {
      const name = f.replace("_device.json", "");
      if (ORACLE[name]?.registry && !["washer", "dryer", "dishwasher", "flexdry"].includes(ORACLE[name].registry)) continue;
      const s = stateOf(name);
      const prim = buildServices(s, deviceTypesFrom(s.get("/oic/d"))).services.find((x) => x.service === "Valve");
      if (!prim) continue;
      const v = prim.chars.find((c) => c.char === "RemainingDuration")!.get!(s);
      if (v === undefined) continue;
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(14400);
      if ((v as number) > 0) sawNonZero = true;
    }
    expect(sawNonZero).toBe(true); // at least one device reports remaining time (was always 0 before)
  });
});

describe("oven/range cook temperature converts Fahrenheit to Celsius", () => {
  it("a Fahrenheit cook/probe temp reads in a Celsius range, not the raw F number", () => {
    // find a fixture whose temperature resource declares units F
    const files = readdirSync(FIX).filter((n) => n.endsWith("_device.json"));
    let checked = 0;
    for (const f of files) {
      const name = f.replace("_device.json", "");
      const s = stateOf(name);
      const fTemp = [...s.entries()].find(([h, r]) => /\/temperature(\/|$)/.test(h) &&
        String((r as Record<string, unknown>)["units"] ?? "").toUpperCase().startsWith("F") &&
        typeof (r as Record<string, unknown>)["temperature"] === "number");
      if (!fTemp) continue;
      const rawF = (fTemp[1] as Record<string, number>)["temperature"];
      const svc = buildServices(s, deviceTypesFrom(s.get("/oic/d"))).services.find((x) => x.sourceHrefs.includes(fTemp[0]));
      if (!svc) continue;
      const c = svc.chars[0].get!(s) as number;
      expect(c).toBeLessThan(rawF); // converted (°C < °F for the same reading above -40)
      expect(c).toBeCloseTo(((rawF - 32) * 5) / 9, 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0); // the corpus has at least one Fahrenheit temp
  });
});
