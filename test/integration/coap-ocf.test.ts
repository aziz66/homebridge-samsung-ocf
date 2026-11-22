import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DtlsClientTransport } from "../../src/dtls/transport";
import { CoapSession } from "../../src/coap/session";
import { encodeCbor, decodeCbor } from "../../src/ocf/cbor";
import { mintClientCertificate, mintEcdsaServerCertificate, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { SimAppliance, parseDevice0, type SimApplianceState } from "../sim/appliance";

const FIX = join(__dirname, "..", "fixtures", "samsung");
function loadFixture(name: string): SimApplianceState {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return { device0: d.device0, resources: parseDevice0(d.device0) };
}

let sim: SimAppliance | undefined;
let client: DtlsClientTransport | undefined;
let session: CoapSession | undefined;

async function connect(name: string) {
  const state = loadFixture(name);
  sim = new SimAppliance(state);
  const srv = await mintEcdsaServerCertificate();
  const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
  await sim.start(srv.certPem, srv.keyPem);
  client = new DtlsClientTransport({ host: "127.0.0.1", port: sim.port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 10000 });
  await client.connect();
  await sim.connected;
  session = new CoapSession(client, { rateLimitRps: 50 });
  return state;
}

afterEach(async () => {
  session?.close();
  await client?.close();
  await sim?.close();
  sim = client = session = undefined;
});

describe("CoAP/OCF session ↔ simulated appliance (AC fixture)", () => {
  it("GET /oic/res returns the resource directory (synthesized from the batch)", async () => {
    // Note: this fixture's /device/0 batch does not include /oic/d — real
    // appliances serve /oic/d and /oic/res as separate reads, so OCF discovery
    // must read them live rather than expecting them in the batch.
    await connect("airconditioner_tp1x_da_ac_rac_01011");
    const r = await session!.get(["oic", "res"]);
    expect(r.code).toBe(0x45); // 2.05
    const links = decodeCbor<Array<{ href: string }>>(r.payload);
    expect(Array.isArray(links)).toBe(true);
    expect(links.some((l) => l.href?.includes("/vs/0"))).toBe(true);
  });

  it("GET /device/0 reassembles the large batch via Block2", async () => {
    const state = await connect("airconditioner_tp1x_da_ac_rac_01011");
    const r = await session!.get(["device", "0"]);
    expect(r.code).toBe(0x45);
    const list = decodeCbor<unknown[]>(r.payload);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(state.device0.length);
    // ensure the payload was actually larger than one 1024-byte block
    expect(encodeCbor(state.device0).length).toBeGreaterThan(1024);
  });

  it("GET an individual resource href", async () => {
    await connect("airconditioner_tp1x_da_ac_rac_01011");
    const r = await session!.get(["temperatures", "vs", "0"]).catch(() => null);
    // not every fixture has that exact href; assert a known one instead
    const known = Object.keys(loadFixture("airconditioner_tp1x_da_ac_rac_01011").resources)[1];
    const segs = known.split("/").filter(Boolean);
    const r2 = await session!.get(segs);
    expect(r2.code).toBe(0x45);
    expect(decodeCbor(r2.payload)).toBeTypeOf("object");
  });

  it("POST writes a CBOR payload and the appliance records it", async () => {
    await connect("airconditioner_tp1x_da_ac_rac_01011");
    const body = encodeCbor({ "x.com.samsung.da.mode": "Cool" });
    const r = await session!.post(["mode", "vs", "0"], body);
    expect(r.code).toBe(0x44); // 2.04 Changed
    expect(sim!.writes.length).toBe(1);
    expect(sim!.writes[0].href).toBe("/mode/vs/0");
    expect(decodeCbor(sim!.writes[0].payload)).toEqual({ "x.com.samsung.da.mode": "Cool" });
  });

  it("OBSERVE receives the seed and a pushed notification", async () => {
    const state = await connect("airconditioner_tp1x_da_ac_rac_01011");
    const href = Object.keys(state.resources).find((h) => h.includes("/vs/0"))!;
    const segs = href.split("/").filter(Boolean);
    const got: { seq: number | null; payload: Record<string, unknown> }[] = [];
    await session!.observe(segs, (_h, payload, seq) => got.push({ seq, payload: decodeCbor(payload) }));
    await new Promise((r) => setTimeout(r, 300));
    // push a change
    sim!.pushNotification(href, { "x.com.samsung.da.changed": "yes" });
    await new Promise((r) => setTimeout(r, 300));
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got[got.length - 1].payload).toEqual({ "x.com.samsung.da.changed": "yes" });
  });
});
