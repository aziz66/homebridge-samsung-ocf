import { describe, it, expect } from "vitest";
import { mintClientCertificate, assertValidUuid, DEFAULT_CLIENT_UUID } from "../../src/auth/cert";

function pemToDer(pem: string): Buffer {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

describe("client certificate", () => {
  it("embeds uuid:<uuid> in the subject (memmem-locatable by TizenRT)", async () => {
    const cred = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    // the DER contains the literal "uuid:<uuid>" in the subject DN
    const der = pemToDer(cred.certPem);
    expect(der.toString("latin1")).toContain(`uuid:${DEFAULT_CLIENT_UUID}`);
    expect(cred.keyPem).toContain("BEGIN PRIVATE KEY"); // PKCS#8
  });

  it("the Certificate handshake fits one 1200-byte DTLS datagram (no client-cert fragmentation)", async () => {
    const cred = await mintClientCertificate(DEFAULT_CLIENT_UUID);
    const der = pemToDer(cred.certPem);
    // CoAP/DTLS Certificate message overhead: record(13) + handshake header(12)
    // + Certificate list/length prefixes(6) ≈ 31 bytes. The appliance drops a
    // client cert split across two datagrams, so the whole thing must be < 1200.
    expect(der.length + 31).toBeLessThan(1200);
  });

  it("rejects a non-UUID before it can reach a subject or file path", () => {
    expect(() => assertValidUuid("../../etc/passwd")).toThrow();
    expect(() => assertValidUuid(DEFAULT_CLIENT_UUID)).not.toThrow();
  });
});
