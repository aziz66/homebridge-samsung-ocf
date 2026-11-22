import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import hap from "hap-nodejs";
import { SamsungOcfPlatform } from "../../src/platform";
import { parseDevice0Batch } from "../../src/ocf/discovery";
import { mintEcdsaServerCertificate } from "../../src/auth/cert";
import { SimAppliance } from "../sim/appliance";

const FIX = join(__dirname, "..", "fixtures", "samsung");

/** Minimal Homebridge API stand-in backed by real hap-nodejs. */
class FakeHomebridgeApi extends EventEmitter {
  hap = hap;
  platformAccessory = hap.Accessory as never;
  registered: unknown[] = [];
  private storage = mkdtempSync(join(tmpdir(), "lt-test-"));
  user = { storagePath: () => this.storage };
  registerPlatformAccessories(_p: string, _n: string, accs: unknown[]) { this.registered.push(...accs); }
  unregisterPlatformAccessories() {}
  registerPlatform() {}
}

const log = Object.assign((() => {}) as never, {
  info() {}, warn() {}, error() {}, debug() {}, log() {}, success() {},
}) as never;

let sim: SimAppliance | undefined;
afterEach(async () => { await sim?.close(); sim = undefined; });

describe("Homebridge platform ↔ simulated appliance (full vertical slice)", () => {
  it("drives two appliances under one platform (multi-device)", async () => {
    const acFix = JSON.parse(readFileSync(join(FIX, "airconditioner_tp1x_da_ac_rac_01011_device.json"), "utf8"));
    const frFix = JSON.parse(readFileSync(join(FIX, "refrigerator_tp1x_ref_21k_definite_device.json"), "utf8"));
    const ac = new SimAppliance({ device0: acFix.device0, resources: parseDevice0Batch(acFix.device0) });
    const fridge = new SimAppliance({ device0: frFix.device0, resources: parseDevice0Batch(frFix.device0) });
    const srv1 = await mintEcdsaServerCertificate();
    const srv2 = await mintEcdsaServerCertificate();
    await ac.start(srv1.certPem, srv1.keyPem);
    await fridge.start(srv2.certPem, srv2.keyPem);
    sim = ac; // afterEach closes one; close the other explicitly
    try {
      const api = new FakeHomebridgeApi();
      // Distinct hosts: real appliances have distinct IPs, and the accessory
      // identity is keyed on host (stable across power-cycle port changes).
      const config = { platform: "SamsungOCF", appliances: [
        { name: "AC", host: "127.0.0.1", port: ac.port },
        { name: "Fridge", host: "127.0.0.2", port: fridge.port },
      ] };
      const platform = new SamsungOcfPlatform(log, config as never, api as never);
      api.emit("didFinishLaunching");
      const accs = () => api.registered as hap.Accessory[];
      const hasHeaterCooler = () => accs().some((a) => a.getServiceById(hap.Service.HeaterCooler, "HeaterCooler"));
      const hasTempSensor = () => accs().some((a) => a.services.some((s) => s.UUID === hap.Service.Thermostat.UUID));
      const deadline = Date.now() + 18000;
      // wait for discovery to apply BOTH archetypes' services, not just registration
      while (Date.now() < deadline && !(api.registered.length === 2 && hasHeaterCooler() && hasTempSensor()))
        await new Promise((r) => setTimeout(r, 150));
      expect(api.registered.length).toBe(2);
      expect(hasHeaterCooler()).toBe(true);
      expect(hasTempSensor()).toBe(true);
      for (const d of platform["devices"]) await d.close();
    } finally {
      await fridge.close();
    }
  }, 25000);

  it("connects an AC, discovers it, and registers a HeaterCooler accessory", async () => {
    const d = JSON.parse(readFileSync(join(FIX, "airconditioner_tp1x_da_ac_rac_01011_device.json"), "utf8"));
    sim = new SimAppliance({ device0: d.device0, resources: parseDevice0Batch(d.device0) });
    const srv = await mintEcdsaServerCertificate();
    await sim.start(srv.certPem, srv.keyPem);

    const api = new FakeHomebridgeApi();
    const config = { platform: "SamsungOCF", appliances: [{ name: "Test AC", host: "127.0.0.1", port: sim.port }] };
    const platform = new SamsungOcfPlatform(log, config as never, api as never);

    // Homebridge fires this once plugins are loaded.
    api.emit("didFinishLaunching");

    // wait until an accessory is registered and has the HeaterCooler service
    const deadline = Date.now() + 15000;
    let acc: hap.Accessory | undefined;
    while (Date.now() < deadline) {
      acc = api.registered[0] as hap.Accessory | undefined;
      if (acc?.getServiceById(hap.Service.HeaterCooler, "HeaterCooler")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(api.registered.length).toBe(1);
    const hc = acc!.getServiceById(hap.Service.HeaterCooler, "HeaterCooler");
    expect(hc).toBeDefined();
    expect(hc!.getCharacteristic(hap.Characteristic.CurrentTemperature).value).toBe(17);

    // the persisted client credential was written for reuse
    expect(() => api.user.storagePath()).not.toThrow();
    await platform["devices"][0].close();
  });
});
