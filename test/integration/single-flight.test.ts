import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { OcfDevice } from "../../src/ocf/device";
import { mintClientCertificate, mintEcdsaServerCertificate, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { SimAppliance, parseDevice0 } from "../sim/appliance";
const FIX = join(__dirname, "..", "fixtures", "samsung");
function load() { const d = JSON.parse(readFileSync(join(FIX, "airconditioner_tp1x_da_ac_rac_01011_device.json"), "utf8")); return { device0: d.device0, resources: parseDevice0(d.device0) }; }
function freePort(): Promise<number> { return new Promise((r) => { const s = createSocket("udp4"); s.bind(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
let sim: SimAppliance | undefined, dev: OcfDevice | undefined;
afterEach(async () => { await dev?.close(); await sim?.close(); sim = dev = undefined; });

describe("reconnect is single-flight", () => {
  it("one drop emits exactly one offline even with requests in flight", async () => {
    const srv = await mintEcdsaServerCertificate(); const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    const port = await freePort();
    sim = new SimAppliance(load());
    await sim.start(srv.certPem, srv.keyPem, port);
    dev = new OcfDevice({ host: "127.0.0.1", port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 1500, coapTimeoutMs: 800, rateLimitRps: 50, pollIntervalMs: 200 });
    const online = once(dev, "online");
    await dev.start();
    await online;
    let offlines = 0;
    dev.on("offline", () => offlines++);
    // Drop the appliance while polls/observe refetches are in flight.
    await sim.close();
    await new Promise((r) => setTimeout(r, 2500)); // long enough for several poll cycles
    expect(offlines).toBe(1); // the draining guard coalesces re-entrant drops
  }, 20000);
});
