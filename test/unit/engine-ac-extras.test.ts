import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import type { StateMap, WriteOp } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
const one = (op: WriteOp | WriteOp[] | null): WriteOp => (Array.isArray(op) ? op[0] : op!) as WriteOp;

describe("AC Fahrenheit handling", () => {
  it("converts a Fahrenheit device to Celsius for HomeKit and back on write", () => {
    const state: StateMap = new Map<string, Record<string, unknown>>([
      ["/power/vs/0", { "x.com.samsung.da.power": "On" }],
      ["/mode/vs/0", { workingMode: "Cool", "x.com.samsung.da.supportedModes": ["Auto", "Cool", "Heat"] }],
      ["/temperatures/vs/0", { "x.com.samsung.da.items": [{
        "x.com.samsung.da.id": "0", "x.com.samsung.da.current": "72", "x.com.samsung.da.desired": "72",
        "x.com.samsung.da.minimum": "61", "x.com.samsung.da.maximum": "86", "x.com.samsung.da.increment": "1",
        "x.com.samsung.da.unit": "Fahrenheit",
      }] }],
    ]);
    const hc = buildServices(state, ["oic.d.airconditioner"]).services.find((s) => s.service === "HeaterCooler")!;
    const cur = hc.chars.find((c) => c.char === "CurrentTemperature")!.get!(state) as number;
    expect(cur).toBeCloseTo(22.22, 1); // 72 °F
    // setting 22 °C writes back ~72 °F, quantized to the 1° increment
    const w = one(hc.chars.find((c) => c.char === "CoolingThresholdTemperature")!.set!(22, state));
    expect((w.rep["x.com.samsung.da.items"] as Array<Record<string, unknown>>)[0]["x.com.samsung.da.desired"]).toBe("72");
    // props are in Celsius bounds
    const props = hc.chars.find((c) => c.char === "CoolingThresholdTemperature")!.props!;
    expect(props.minValue).toBe(17); // ceil(fToC(61))
    expect(props.maxValue).toBe(30); // floor(fToC(86))
  });
});

describe("AC optional-mode switches (opt-in)", () => {
  const d = JSON.parse(readFileSync(join(FIX, "airconditioner_tp1x_da_ac_rac_01011_device.json"), "utf8"));
  const state: StateMap = new Map(Object.entries(parseDevice0Batch(d.device0)));

  it("adds no optional-mode switches by default", () => {
    const r = buildServices(state, []);
    expect(r.services.some((s) => s.subtype?.startsWith("convenient-"))).toBe(false);
  });

  it("exposes requested modes as switches with reference-exact writes", () => {
    const r = buildServices(state, [], { optionalModes: ["Sleep", "Speed", "NotAReal Mode"] });
    const sw = r.services.filter((s) => s.subtype?.startsWith("convenient-"));
    expect(sw.map((s) => s.name).sort()).toEqual(["Sleep", "Speed"]); // bogus one skipped (not supported)
    const sleep = sw.find((s) => s.name === "Sleep")!.chars[0];
    expect(sleep.get!(state)).toBe(false); // fixture mode is "Off"
    expect(one(sleep.set!(true, state))).toMatchObject({ href: "/mode/convenient/vs/0", rep: { "x.com.samsung.da.modes": "Sleep" } });
    expect(one(sleep.set!(false, state))).toMatchObject({ href: "/mode/convenient/vs/0", rep: { "x.com.samsung.da.modes": "Off" } });
  });
});
