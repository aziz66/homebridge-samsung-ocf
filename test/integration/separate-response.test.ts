import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DtlsClientTransport } from "../../src/dtls/transport";
import { CoapSession } from "../../src/coap/session";
import { decodeCbor } from "../../src/ocf/cbor";
import { mintClientCertificate, mintEcdsaServerCertificate, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { SimAppliance, parseDevice0 } from "../sim/appliance";

const FIX = join(__dirname, "..", "fixtures", "samsung");
let sim: SimAppliance | undefined, client: DtlsClientTransport | undefined, session: CoapSession | undefined;
afterEach(async () => { session?.close(); await client?.close(); await sim?.close(); sim = client = session = undefined; });

describe("separate CoAP response (ACK then CON) ↔ session", () => {
  it("resolves a small GET delivered as empty-ACK + separate CON", async () => {
    const d = JSON.parse(readFileSync(join(FIX, "airconditioner_tp1x_da_ac_rac_01011_device.json"), "utf8"));
    sim = new SimAppliance({ device0: d.device0, resources: parseDevice0(d.device0) });
    sim.separateResponses = true;
    const srv = await mintEcdsaServerCertificate();
    const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    await sim.start(srv.certPem, srv.keyPem);
    client = new DtlsClientTransport({ host: "127.0.0.1", port: sim.port, cert: cli.certPem, key: cli.keyPem, connectTimeoutMs: 10000 });
    await client.connect();
    await sim.connected;
    session = new CoapSession(client, { rateLimitRps: 50 });
    // a single resource rep is small → separate-response path
    const href = Object.keys(parseDevice0(d.device0)).find((h) => h.includes("/vs/0"))!;
    const r = await session.get(href.split("/").filter(Boolean));
    expect(r.code).toBe(0x45);
    expect(decodeCbor(r.payload)).toBeTypeOf("object");
  });
});
