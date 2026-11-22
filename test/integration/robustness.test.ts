import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { OcfDevice } from "../../src/ocf/device";
import { DtlsClientTransport } from "../../src/dtls/transport";
import { mintClientCertificate, mintEcdsaServerCertificate, assertValidUuid, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { SimAppliance, parseDevice0, type SimApplianceState } from "../sim/appliance";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function loadFixture(name: string): SimApplianceState {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return { device0: d.device0, resources: parseDevice0(d.device0) };
}
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    s.bind(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function certs() {
  return { srv: await mintEcdsaServerCertificate(), cli: await mintClientCertificate(DEFAULT_CLIENT_UUID) };
}

let sim: SimAppliance | undefined, dev: OcfDevice | undefined, client: DtlsClientTransport | undefined;
afterEach(async () => { await dev?.close(); await client?.close(); await sim?.close(); sim = dev = client = undefined; });

describe("robustness", () => {
  it("uuid validation rejects anything that is not a UUID", async () => {
    expect(() => assertValidUuid("ab0b0ac4-aae9-4958-a04d-8ec36fe1b2f9")).not.toThrow();
    for (const bad of ["../etc/passwd", "not-a-uuid", "", "a/b", "ab0b0ac4"]) {
      expect(() => assertValidUuid(bad)).toThrow();
    }
    await expect(mintClientCertificate("../evil")).rejects.toThrow(/invalid appliance UUID/);
  });

  it("connects when the appliance is OFF at startup and comes up later (cold reconnect)", async () => {
    const { srv, cli } = await certs();
    const port = await freePort();
    dev = new OcfDevice({ host: "127.0.0.1", port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 700, coapTimeoutMs: 2500, rateLimitRps: 50, pollIntervalMs: 500 });
    const online = once(dev, "online");
    await dev.start(); // nothing is listening — must not throw, schedules a retry
    expect(dev.state.size).toBe(0);
    // appliance appears on that port
    sim = new SimAppliance(loadFixture("airconditioner_tp1x_da_ac_rac_01011"));
    await sim.start(srv.certPem, srv.keyPem, port);
    await online; // backoff retry connects
    expect(dev.state.size).toBeGreaterThan(0);
  }, 20000);

  it("reconnects after a mid-session drop (appliance restarts on the same port)", async () => {
    const { srv, cli } = await certs();
    const port = await freePort();
    sim = new SimAppliance(loadFixture("airconditioner_tp1x_da_ac_rac_01011"));
    await sim.start(srv.certPem, srv.keyPem, port);
    dev = new OcfDevice({ host: "127.0.0.1", port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 1500, coapTimeoutMs: 2000, rateLimitRps: 50, pollIntervalMs: 400 });
    const online1 = once(dev, "online"); // register BEFORE start(): start() emits online then resolves
    await dev.start();
    await online1;
    // appliance drops; a poll will time out and the device goes offline
    const offline = once(dev, "offline");
    const online2 = once(dev, "online"); // register before the reconnect can fire
    await sim.close();
    await offline;
    // appliance comes back on the same port; the backoff retry reconnects
    sim = new SimAppliance(loadFixture("airconditioner_tp1x_da_ac_rac_01011"));
    await sim.start(srv.certPem, srv.keyPem, port);
    await online2;
    expect(dev.state.size).toBeGreaterThan(0);
  }, 30000);

  it("a close during/after connect raises no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const { cli } = await certs();
      const port = await freePort(); // nothing listening → handshake will retransmit
      client = new DtlsClientTransport({ host: "127.0.0.1", port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 600 });
      await client.connect().catch(() => {});
      await client.close();
      // werift keeps retransmitting the handshake for tens of seconds; hold long
      // enough to cover its exhaustion path, during which stray sends could fire.
      await new Promise((r) => setTimeout(r, 16000));
    } finally {
      process.off("unhandledRejection", onRej);
    }
    expect(rejections).toEqual([]);
  }, 25000);
});
