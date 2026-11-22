import { describe, it, expect, afterEach } from "vitest";
import { DtlsClientTransport, SIG_RSA } from "../../src/dtls/transport";
import { mintClientCertificate, mintEcdsaServerCertificate, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";
import { startSimDtlsServer, type SimDtlsServer } from "../sim/dtls-server";

let server: SimDtlsServer | undefined;
let client: DtlsClientTransport | undefined;
afterEach(async () => {
  await client?.close();
  await server?.close();
  server = undefined;
  client = undefined;
});

describe("DTLS transport ↔ simulator (in-process werift peer)", () => {
  it("completes a client-cert handshake and exchanges datagrams both ways", async () => {
    const srv = await mintEcdsaServerCertificate();
    const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    server = await startSimDtlsServer(srv.certPem, srv.keyPem);

    const received: Buffer[] = [];
    server.onData = (d) => {
      received.push(d);
      // echo back, uppercased, to prove the reverse direction
      void server!.send(Buffer.from(d.toString().toUpperCase()));
    };

    client = new DtlsClientTransport({
      host: "127.0.0.1",
      port: server.port,
      cert: cli.certPem,
      key: cli.keyPem,
      signatureHash: SIG_RSA,
      connectTimeoutMs: 10_000,
    });
    const echoes: Buffer[] = [];
    client.onData = (d) => echoes.push(d);

    await client.connect();
    expect(client.isConnected).toBe(true);
    await server.connected;

    await client.send(Buffer.from("hello-appliance"));
    await new Promise((r) => setTimeout(r, 400));

    expect(received.map((b) => b.toString())).toContain("hello-appliance");
    expect(echoes.map((b) => b.toString())).toContain("HELLO-APPLIANCE");
  });

  it("times out on a silent port instead of hanging forever", async () => {
    const cli = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    client = new DtlsClientTransport({
      host: "127.0.0.1",
      port: 1, // nothing listening
      cert: cli.certPem,
      key: cli.keyPem,
      connectTimeoutMs: 800,
    });
    const t0 = Date.now();
    await expect(client.connect()).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(client.isConnected).toBe(false);
  });
});
