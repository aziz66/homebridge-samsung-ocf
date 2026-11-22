import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OcfDevice } from "../../src/ocf/device";
import { mintClientCertificate, mintEcdsaServerCertificate, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { SimAppliance, parseDevice0, type SimApplianceState } from "../sim/appliance";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function loadFixture(name: string): SimApplianceState {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return { device0: d.device0, resources: parseDevice0(d.device0) };
}

let sim: SimAppliance | undefined;
let dev: OcfDevice | undefined;
afterEach(async () => {
  await dev?.close();
  await sim?.close();
  sim = dev = undefined;
});

async function spin(name: string, observeHrefs: string[] = []) {
  const state = loadFixture(name);
  sim = new SimAppliance(state);
  const srv = await mintEcdsaServerCertificate();
  const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
  await sim.start(srv.certPem, srv.keyPem);
  dev = new OcfDevice({
    host: "127.0.0.1", port: sim.port, cert: cli.certPem, key: cli.keyPem,
    connectTimeoutMs: 10000, pollIntervalMs: 500, observeHrefs,
  });
  return { state };
}

describe("OcfDevice ↔ simulated appliance", () => {
  it("connects, discovers the batch into the state cache, emits online", async () => {
    const { state } = await spin("airconditioner_tp1x_da_ac_rac_01011");
    const online = new Promise<void>((r) => dev!.once("online", () => r()));
    await dev!.start();
    await online;
    // every non-stub resource from the batch is in the cache
    const expected = Object.keys(state.resources).length;
    expect(dev!.state.size).toBe(expected);
    expect(dev!.state.has("/temperatures/vs/0") || [...dev!.state.keys()].some((k) => k.includes("/vs/0"))).toBe(true);
  });

  it("writes a resource that the appliance records", async () => {
    await spin("airconditioner_tp1x_da_ac_rac_01011");
    await dev!.start();
    const ok = await dev!.write("/mode/vs/0", { "x.com.samsung.da.mode": "Cool" });
    expect(ok).toBe(true);
    expect(sim!.writes.at(-1)?.href).toBe("/mode/vs/0");
  });

  it("delivers an OBSERVE push as a state update", async () => {
    const { state } = await spin(
      "airconditioner_tp1x_da_ac_rac_01011",
      // observe the first /vs/0 resource in the fixture
      [Object.keys(loadFixture("airconditioner_tp1x_da_ac_rac_01011").resources).find((h) => h.includes("/vs/0"))!],
    );
    await dev!.start();
    const href = Object.keys(state.resources).find((h) => h.includes("/vs/0"))!;
    const updated = new Promise<[string, Record<string, unknown>]>((r) =>
      dev!.once("update", (h, rep) => r([h, rep])),
    );
    await new Promise((r) => setTimeout(r, 200));
    sim!.pushNotification(href, { "x.com.samsung.da.pushed": "1" });
    const [h, rep] = await updated;
    expect(h).toBe(href);
    expect(rep).toEqual({ "x.com.samsung.da.pushed": "1" });
  });
});
