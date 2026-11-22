import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import type { StateMap } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}
function firstFixture(substr: string): string {
  const f = readdirSync(FIX).find((n) => n.includes(substr) && n.endsWith("_device.json"));
  if (!f) throw new Error("no fixture " + substr);
  return f.replace("_device.json", "");
}

describe("capability engine → HomeKit specs", () => {
  it("air conditioner → HeaterCooler with live current temperature and modes", () => {
    const s = stateOf("airconditioner_tp1x_da_ac_rac_01011");
    const r = buildServices(s, []);
    expect(r.archetype).toBe("ac");
    const hc = r.services.find((x) => x.service === "HeaterCooler");
    expect(hc).toBeDefined();
    const cur = hc!.chars.find((c) => c.char === "CurrentTemperature")!;
    expect(cur.get!(s)).toBe(17); // fixture's x.com.samsung.da.current "17.0"
    const active = hc!.chars.find((c) => c.char === "Active")!;
    expect(active.get!(s)).toBe(0); // fixture power is "Off"
    const target = hc!.chars.find((c) => c.char === "TargetHeaterCoolerState")!;
    expect(typeof target.get!(s)).toBe("number");
    // setting a threshold produces a write op to /temperatures with a guard
    const w = hc!.chars.find((c) => c.char === "CoolingThresholdTemperature")!.set!(24, s);
    expect(w).toMatchObject({ href: expect.stringContaining("/temperatures"), requiresRemoteControl: true });
  });

  it("refrigerator → writable Thermostat per zone and door contacts", () => {
    const name = firstFixture("refrigerator_tp1x_ref_21k_definite");
    const s = stateOf(name);
    const r = buildServices(s, ["oic.d.refrigerator"]);
    const zones = r.services.filter((x) => x.service === "Thermostat");
    expect(zones.length).toBeGreaterThanOrEqual(1);
    for (const z of zones) {
      const target = z.chars.find((c) => c.char === "TargetTemperature")!;
      expect(typeof target.get!(s)).toBe("number");
      expect(target.set).toBeDefined(); // writable now, not a read-only sensor
    }
    expect(r.services.some((x) => x.service === "ContactSensor")).toBe(true);
  });

  it("washer/dryer → laundry primary with Active + RemainingDuration", () => {
    const name = firstFixture("dryer_device") === "dryer" ? "dryer" : firstFixture("dryer");
    const s = stateOf("dryer");
    const r = buildServices(s, ["oic.d.dryer"]);
    expect(r.archetype).toBe("laundry");
    const prim = r.services.find((x) => x.primary)!;
    expect(prim.chars.some((c) => c.char === "InUse")).toBe(true);
    const rem = prim.chars.find((c) => c.char === "RemainingDuration");
    expect(rem).toBeDefined();
    expect(["number", "undefined"]).toContain(typeof rem!.get!(s));
  });

  it("air purifier → AirPurifier primary", () => {
    const name = firstFixture("air_purifier_avt_ww_device") === "air_purifier_avt_ww" ? "air_purifier_avt_ww" : firstFixture("air_purifier");
    const s = stateOf(name);
    const r = buildServices(s, ["oic.d.airpurifier"]);
    expect(r.archetype).toBe("air_purifier");
    expect(r.services.some((x) => x.service === "AirPurifier")).toBe(true);
  });

  it("never throws on any fixture and always marks consumed hrefs", () => {
    const names = readdirSync(FIX).filter((n) => n.endsWith("_device.json"));
    let withPrimary = 0;
    for (const f of names) {
      const s = stateOf(f.replace("_device.json", ""));
      const r = buildServices(s, []);
      expect(r.mappedHrefs).toBeInstanceOf(Set);
      if (r.services.some((x) => x.primary)) withPrimary++;
    }
    expect(withPrimary).toBeGreaterThan(0);
  });
});
