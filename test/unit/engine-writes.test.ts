import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import type { StateMap, WriteOp } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}
const one = (op: WriteOp | WriteOp[] | null): WriteOp => (Array.isArray(op) ? op[0] : op!) as WriteOp;

describe("AC write payloads match the reference _climate_write exactly", () => {
  // Reference (airconditioner.py _climate_write), confirmed by reading the source:
  //   power: /power/vs/0  {x.com.samsung.da.power: On|Off}
  //   mode:  /mode/vs/0   {x.com.samsung.da.modes: [value]}
  //   temp:  /temperatures/vs/0 {x.com.samsung.da.items:[{id:"0", desired: str}]}
  //   fan:   /wind/strength/vs/0 {x.com.samsung.da.modes: <index string>}
  const s = stateOf("airconditioner_tp1x_da_ac_rac_01011");
  const hc = buildServices(s, []).services.find((x) => x.service === "HeaterCooler")!;
  const ch = (name: string) => hc.chars.find((c) => c.char === name)!;

  it("power → /power/vs/0", () => {
    expect(one(ch("Active").set!(1, s))).toMatchObject({ href: "/power/vs/0", rep: { "x.com.samsung.da.power": "On" } });
    expect(one(ch("Active").set!(0, s))).toMatchObject({ href: "/power/vs/0", rep: { "x.com.samsung.da.power": "Off" } });
  });
  it("mode → /mode/vs/0 {modes:[value]}", () => {
    expect(one(ch("TargetHeaterCoolerState").set!(2, s))).toMatchObject({ href: "/mode/vs/0", rep: { "x.com.samsung.da.modes": ["Cool"] } });
    expect(one(ch("TargetHeaterCoolerState").set!(1, s))).toMatchObject({ href: "/mode/vs/0", rep: { "x.com.samsung.da.modes": ["Heat"] } });
  });
  it("setpoint → /temperatures/vs/0 items", () => {
    const w = one(ch("CoolingThresholdTemperature").set!(24, s));
    expect(w.href).toBe("/temperatures/vs/0");
    expect(w.rep).toEqual({ "x.com.samsung.da.items": [{ "x.com.samsung.da.id": "0", "x.com.samsung.da.desired": "24" }] });
  });
  it("fan → /wind/strength/vs/0 {modes:<index>}", () => {
    // 5 modes (0..4), so 50% → index 2
    const w = one(ch("RotationSpeed").set!(50, s));
    expect(w.href).toBe("/wind/strength/vs/0");
    expect(w.rep).toEqual({ "x.com.samsung.da.modes": "2" });
  });
  it("swing → /wind/direction/vs/0 {modes} (reference _climate_write swing)", () => {
    const sw = hc.chars.find((c) => c.char === "SwingMode");
    expect(sw).toBeDefined();
    expect(one(sw!.set!(1, s))).toMatchObject({ href: "/wind/direction/vs/0", rep: { "x.com.samsung.da.modes": "All" } });
    expect(one(sw!.set!(0, s))).toMatchObject({ href: "/wind/direction/vs/0", rep: { "x.com.samsung.da.modes": "Fix" } });
  });
  it("display light → /light/vs/0 {mode} (reference DISPLAY_LIGHT write)", () => {
    const all = buildServices(s, []).services;
    const light = all.find((x) => x.service === "Lightbulb")!;
    expect(light).toBeDefined();
    const on = light.chars.find((c) => c.char === "On")!;
    expect(one(on.set!(true, s))).toMatchObject({ href: "/light/vs/0", rep: { mode: "On" } });
    expect(one(on.set!(false, s))).toMatchObject({ href: "/light/vs/0", rep: { mode: "Off" } });
    expect(on.get!(s)).toBe(true); // fixture reports mode "On"
  });

  it("every AC write is guarded on remote control", () => {
    for (const name of ["Active", "TargetHeaterCoolerState", "CoolingThresholdTemperature", "RotationSpeed"]) {
      expect(one(ch(name).set!(name === "RotationSpeed" ? 50 : 1, s)).requiresRemoteControl).toBe(true);
    }
  });
});
