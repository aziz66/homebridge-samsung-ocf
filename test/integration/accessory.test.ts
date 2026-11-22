import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import hap from "hap-nodejs";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import { applyServices, type DeviceLike, type Logger } from "../../src/homekit/accessory";
import type { StateMap } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeDevice extends EventEmitter implements DeviceLike {
  writes: { href: string; rep: Record<string, unknown> }[] = [];
  allowRemoteOffWrites = true; // avoid the guard in this fixture (power Off)
  constructor(public state: StateMap) { super(); }
  async write(href: string, rep: Record<string, unknown>) { this.writes.push({ href, rep }); return true; }
}

function warningSink(accessory: hap.Accessory): string[] {
  const warnings: string[] = [];
  accessory.on("characteristic-warning" as never, (w: unknown) => warnings.push(JSON.stringify(w)));
  return warnings;
}

describe("HAP accessory wiring (real hap-nodejs)", () => {
  it("air conditioner builds a valid HeaterCooler with no characteristic warnings", async () => {
    const state = stateOf("airconditioner_tp1x_da_ac_rac_01011");
    const specs = buildServices(state, []).services;
    const device = new FakeDevice(state);
    const accessory = new hap.Accessory("AC", hap.uuid.generate("test-ac"));
    const warnings = warningSink(accessory);
    applyServices(hap as never, accessory as never, specs, device, silentLog);

    const hc = accessory.getServiceById(hap.Service.HeaterCooler, "HeaterCooler");
    expect(hc).toBeDefined();
    const cur = hc!.getCharacteristic(hap.Characteristic.CurrentTemperature);
    expect(cur.value).toBe(17);
    const active = hc!.getCharacteristic(hap.Characteristic.Active);
    expect(active.value).toBe(0); // power Off in fixture

    // exercise a write through the SET handler
    const cool = hc!.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature);
    await cool.handleSetRequest(23 as never, undefined as never);
    expect(device.writes.length).toBe(1);
    expect(device.writes[0].href).toContain("/temperatures");

    // re-seed values via a device update event (no throw, no warning)
    device.emit("update", "/power/vs/0", {});
    expect(warnings).toEqual([]);
  });

  it("a refrigerator builds Thermostat + ContactSensor services without warnings", () => {
    const state = stateOf("refrigerator_tp1x_ref_21k_definite");
    const specs = buildServices(state, ["oic.d.refrigerator"]).services;
    const device = new FakeDevice(state);
    const accessory = new hap.Accessory("Fridge", hap.uuid.generate("test-fridge"));
    const warnings = warningSink(accessory);
    applyServices(hap as never, accessory as never, specs, device, silentLog);
    device.emit("update", "x", {});
    const zones = accessory.services.filter((s) => s.UUID === hap.Service.Thermostat.UUID);
    const doors = accessory.services.filter((s) => s.UUID === hap.Service.ContactSensor.UUID);
    expect(zones.length).toBeGreaterThanOrEqual(1);
    expect(doors.length).toBeGreaterThanOrEqual(1);
    expect(warnings).toEqual([]);
  });

  it("a dryer builds a valid Valve (Active/InUse/ValveType) without warnings", () => {
    const state = stateOf("dryer");
    const specs = buildServices(state, ["oic.d.dryer"]).services;
    const device = new FakeDevice(state);
    const accessory = new hap.Accessory("Dryer", hap.uuid.generate("test-dryer"));
    const warnings = warningSink(accessory);
    applyServices(hap as never, accessory as never, specs, device, silentLog);
    device.emit("update", "x", {});
    const valve = accessory.services.find((s) => s.UUID === hap.Service.Valve.UUID);
    expect(valve).toBeDefined();
    expect(valve!.getCharacteristic(hap.Characteristic.ValveType).value).toBe(0);
    expect(warnings).toEqual([]);
  });
});
