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

describe("reconnect survives a sustained outage", () => {
  it("keeps retrying across many failures and recovers when the appliance returns", async () => {
    const srv = await mintEcdsaServerCertificate(); const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    const port = await freePort();
    // appliance is DOWN the whole time at first
    dev = new OcfDevice({ host: "127.0.0.1", port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 500, coapTimeoutMs: 1500, rateLimitRps: 50, pollIntervalMs: 500 });
    const online = once(dev, "online");
    let offlines = 0; dev.on("offline", () => offlines++);
    await dev.start();
    // let several backoff cycles elapse with nothing listening (500ms timeout + 1s,2s,4s backoff)
    await new Promise((r) => setTimeout(r, 9000));
    expect(offlines).toBeGreaterThanOrEqual(3); // proves it kept retrying, didn't deadlock
    // appliance finally comes up
    sim = new SimAppliance(load());
    await sim.start(srv.certPem, srv.keyPem, port);
    await online; // must still reconnect after many failures
    expect(dev.state.size).toBeGreaterThan(0);
  }, 40000);
});
