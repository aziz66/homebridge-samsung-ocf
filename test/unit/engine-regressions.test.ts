import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch, deviceTypesFrom } from "../../src/ocf/discovery";
import type { StateMap, WriteOp } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}
const one = (op: WriteOp | WriteOp[] | null): WriteOp => (Array.isArray(op) ? op[0] : op!) as WriteOp;

describe("AirQualitySensor from /sensors/vs/0", () => {
  it("air purifier exposes AirQuality + PM2.5(FineDust) + PM10(Dust)", () => {
    const s = stateOf("air_purifier_avt_ww");
    const aq = buildServices(s, ["oic.d.airpurifier"]).services.find((x) => x.service === "AirQualitySensor")!;
    expect(aq).toBeDefined();
    expect(aq.chars.find((c) => c.char === "PM2_5Density")!.get!(s)).toBe(9);  // FineDust value[0]
    expect(aq.chars.find((c) => c.char === "PM10Density")!.get!(s)).toBe(10); // Dust value[0]
    expect(aq.chars.find((c) => c.char === "AirQuality")!.get!(s)).toBe(1);   // 9 µg/m³ → EXCELLENT
  });
});

describe("Dehumidifier → HumidifierDehumidifier (writable target)", () => {
  it("writes the desired humidity to the reference field", () => {
    const s = stateOf("dehumidifier_tp1x_dhm01001");
    const hd = buildServices(s, deviceTypesFrom(s.get("/oic/d"))).services.find((x) => x.service === "HumidifierDehumidifier")!;
    expect(hd.chars.find((c) => c.char === "CurrentRelativeHumidity")!.get!(s)).toBe(63);
    const thr = hd.chars.find((c) => c.char === "RelativeHumidityDehumidifierThreshold")!;
    expect(thr.get!(s)).toBe(60);
    expect(one(thr.set!(55, s))).toMatchObject({ href: "/humidity/vs/0", rep: { "x.com.samsung.da.desiredHumidity": "55" } });
  });
});

describe("Refrigerator → writable Thermostat snapping to supportedList", () => {
  it("snaps a HomeKit target to the nearest supported discrete value", () => {
    const s = stateOf("refrigerator_tp1x_ref_21k_definite");
    const zones = buildServices(s, ["oic.d.refrigerator"]).services.filter((x) => x.service === "Thermostat");
    const freezer = zones.find((z) => z.subtype?.includes("freezer"))!;
    const tt = freezer.chars.find((c) => c.char === "TargetTemperature")!;
    // supportedList [-23,-21,-19,-17,-15]; HomeKit sends -16 → nearest is -17 (or -15; -16 is equidistant → -17 by reduce order)
    const w = one(tt.set!(-16, s));
    expect(w.href).toContain("/temperature/definite/freezer");
    expect(["-17", "-15"]).toContain((w.rep["x.com.samsung.da.definite.desired"] as string));
    // a value far outside snaps to the extreme
    expect(one(tt.set!(-100, s)).rep["x.com.samsung.da.definite.desired"]).toBe("-23");
  });
});
