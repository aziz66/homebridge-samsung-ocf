/**
 * Client-certificate minting for the Samsung OCF certificate auth path.
 *
 * A compatible appliance authorizes a client by the UUID in its certificate
 * Subject (the appliance's on-device ACL grants that UUID), not by the signer:
 * a self-signed leaf works. This mirrors the reference setup_cert.py default
 * (self-signed; UUID is a published constant). Nothing here contacts an
 * appliance or the Samsung cloud — the key and leaf are generated locally.
 *
 * See research/DTLS-WERIFT-FINDINGS.md and the upstream certificates.md.
 */
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

// Node's WebCrypto; cast through unknown because @peculiar/x509 and the
// WebCrypto algorithm params are typed against the DOM "Crypto" lib, which
// this (DOM-free) tsconfig deliberately does not include.
const crypto = webcrypto as unknown as {
  subtle: {
    generateKey(alg: object, extractable: boolean, usages: string[]): Promise<{ privateKey: unknown; publicKey: unknown }>;
    exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  };
};
x509.cryptoProvider.set(webcrypto as never);

/**
 * The published cloud-service identity UUID that compatible appliances' ACLs
 * grant `perm=31` on `href=*`. It is the constant `CLIENT_UUID` in the
 * reference setup_cert.py (upstream docs/certificates.md explains why rotating
 * it is infeasible for Samsung). TizenRT's IoTivity locates the peer UUID with
 * `memmem(subject, "uuid:")`, so the UUID must appear as `uuid:<uuid>` in the
 * subject DN. Override per-install if a device needs a different authorized UUID.
 */
export const DEFAULT_CLIENT_UUID = "ab0b0ac4-aae9-4958-a04d-8ec36fe1b2f9";

export interface ClientCredential {
  /** PEM leaf certificate. */
  certPem: string;
  /** PEM PKCS#8 private key. */
  keyPem: string;
  /** The UUID embedded in the subject. */
  uuid: string;
}

function pemBlock(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Mint an RSA-2048 self-signed client certificate carrying `uuid` in the
 * subject (OU + CN) and a SAN URI, the way the reference does. Returns PEM
 * cert + PKCS#8 key. Deterministic in structure, random in key material.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Throws on a non-UUID string, so it can never reach a certificate subject or a file path. */
export function assertValidUuid(uuid: string): void {
  if (!UUID_RE.test(uuid)) throw new Error("invalid appliance UUID (expected 8-4-4-4-12 hex): " + JSON.stringify(uuid));
}

export async function mintClientCertificate(uuid: string): Promise<ClientCredential> {
  assertValidUuid(uuid);
  const alg = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  // Subject + SAN mirror the reference setup_cert.py exactly: the UUID appears
  // as "uuid:<uuid>" in OU (found by memmem), with urn:/uri:/bare SAN URIs.
  const name = `OU=uuid:${uuid}, CN=urn:uuid:${uuid}`;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name,
    notBefore: new Date(Date.now() - 24 * 3600 * 1000),
    notAfter: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
    signingAlgorithm: alg as never,
    keys: keys as never,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "url", value: `urn:uuid:${uuid}` },
        { type: "url", value: `uri:uuid:${uuid}` },
        { type: "url", value: `uuid:${uuid}` },
      ]),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certPem: cert.toString("pem") + "\n", keyPem: pemBlock("PRIVATE KEY", pkcs8), uuid };
}

/**
 * Mint an ECDSA P-256 self-signed certificate. Used by the test simulator to
 * stand in for the appliance's server certificate (the appliance presents an
 * ECDSA leaf; the ECDHE-ECDSA cipher requires it). Not used at runtime.
 */
export async function mintEcdsaServerCertificate(
  cn = "appliance",
): Promise<{ certPem: string; keyPem: string }> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `C=KR, O=Samsung Electronics, OU=OCF HA Device, CN=${cn}`,
    notBefore: new Date(Date.now() - 24 * 3600 * 1000),
    notAfter: new Date(Date.now() + 2 * 24 * 3600 * 1000),
    signingAlgorithm: alg as never,
    keys: keys as never,
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certPem: cert.toString("pem") + "\n", keyPem: pemBlock("PRIVATE KEY", pkcs8) };
}
