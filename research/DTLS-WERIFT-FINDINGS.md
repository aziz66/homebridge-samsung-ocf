# DTLS / werift-dtls findings

Research record for choosing the DTLS transport of a native TypeScript Homebridge
plugin for local Samsung OCF appliance control. Everything here is from reading the
reference projects and from a **hardware-free** interop harness (`interop/`), run
against OpenSSL, not against a real appliance.

## The protocol the appliances require (from the reference library)

Source of truth: [`QuiteYellow/SmartThings-Local`](https://github.com/QuiteYellow/SmartThings-Local)
(`smartthings_local/protocol/`), commit `37a20354b9eb1e3b128dc33a7caf470baef7e47e`, and
[`mbillow/localthings`](https://github.com/mbillow/localthings), commit `f86a819c4371be1db3d21e1e06c44b4620dbce33`.

- **Transport:** CoAP (RFC 7252) over **DTLS 1.2**, CoAP Observe (RFC 7641) for push,
  Block2/Block1 (RFC 7959), CBOR payloads. OCF discovery via `/oic/res`, `/oic/d`, `/oic/p`.
- **Certificate path** (dominant; AC14K_M-compatible firmware and OCF-PKI cert devices):
  single cipher **`ECDHE-ECDSA-AES128-GCM-SHA256`** (0xc02b), curve **P-256**, with an
  **X.509 client certificate** whose Subject carries a UUID the appliance's on-device ACL
  grants. The signer is not checked on tested appliances, so a self-signed RSA-2048 leaf
  works; the UUID is a published constant (`setup_cert.py`). MTU note: the appliance drops a
  client cert fragmented across two datagrams, so OpenSSL-side code pins ciphertext MTU 1200.
- **PSK path** (newer OCF-PKI laundry only): **`ECDHE-PSK-AES128-CBC-SHA256`** (0xC037).
  The reference ships a *from-scratch* pure-Python DTLS 1.2 client for exactly this one
  suite, because OpenSSL truncates PSK identities containing a NUL byte.
- **Legacy TCP 8888 path** (≈2018–2022 models): HTTPS/TLS 1.0 with an unverifiable cert;
  plain TCP, not DTLS.

## Library survey

| Library | 0xc02b cert | 0xC037 PSK | Client cert | Notes |
|---|---|---|---|---|
| **werift-dtls** 0.5.8 | **yes** | no | **yes** | WebRTC-derived, but usable as a plain DTLS client |
| node-dtls-client 2.0.3 | no | no (PSK/DHE-PSK/RSA-PSK only, no ECDHE-PSK) | no | PSK-focused (IKEA Tradfri) |
| Node `tls`/`dtls` | n/a | n/a | n/a | Node has no DTLS |

**No off-the-shelf TypeScript DTLS library negotiates 0xC037 (ECDHE-PSK-AES128-CBC-SHA256).**
The PSK path would need a bespoke DTLS client, as the reference did in Python.

## werift-dtls chosen for the certificate path — what was verified

**Config required** (learned the hard way):
```js
new DtlsClient({
  transport,                                   // a dgram-backed { send, onData, ... }
  cert: clientCertPem,
  key:  clientKeyPkcs8Pem,
  certificateRequest: true,
  signatureHash: { hash: 4 /*sha256*/, signature: 1 /*rsa*/ },  // MANDATORY
  // no srtpProfiles  -> no use_srtp extension (clean, non-WebRTC ClientHello)
});
```
If `signatureHash` is omitted, `CipherContext` silently never parses the cert
(`if (certPem && keyPem && signatureHashAlgorithm)`), and flight 5 throws
`Buffer.from(undefined)` in `sendCertificate`. For an ECDSA client cert use `signature: 3`.

**ClientHello (captured bytes).** DTLS 1.2 (`fe fd`); cipher suites `c0 2b`,`c0 2f`;
null compression; extensions: supported_groups `[x25519, secp256r1]`, signature_algorithms
`[rsa_pkcs1_sha256, ecdsa_secp256r1_sha256]`, renegotiation_info. **No use_srtp, no
session-ticket extension** — matches the minimal offer the appliances expect, except that
werift also offers x25519 (harmless: a P-256-only server selects P-256; verified below).

**Interop results (werift client ↔ independent OpenSSL DTLS server):**

| Case | Result |
|---|---|
| P-256, cipher 0xc02b, client-cert validation **enforced** (`-Verify 1 -verify_return_error`) | **handshake finished; OpenSSL logged the client cert subject (`uuid:...`); bidirectional app data** |
| Negative control: wrong trust anchor | OpenSSL rejected the same client cert — `verify error:num=18` → `fatal: unknown CA`; werift did **not** connect |
| x25519 (default groups) | handshake finished, app data |
| Fragmented multi-cert server flight (`-mtu 500`) | reassembled; handshake finished |

The negative control is what makes the positive meaningful: with validation enforced,
werift's client Certificate + CertificateVerify pass a real chain+signature check, and
fail when the anchor is wrong.

## Limitations / things to design around (all honest, not fabricated)

1. **Not hardware-verified.** This proves interop with **OpenSSL**, not with real Samsung
   TizenRT/mbedTLS firmware. Subtle differences (HVR cookie handling, retransmission timing,
   the half-open-HVR-peer quirk the reference handles) are untested here.
2. **`connect()` has no built-in deadline.** With no server it retransmits flight 1 forever
   and never resolves/rejects. The plugin must race `onConnect` against its own timer and abort.
3. **No server authentication in 0.5.8.** The installed JS stores the server cert but does not
   verify its signature, and `verifyRemoteCertificate` exists only in unpublished git HEAD.
   This matches the reference's default cert path (authorization rests on the client-cert UUID
   in the appliance ACL, not on pinning the appliance). Posture: LAN-only, user-supplied IP.
   Server-cert pinning (the reference's optional `SamsungServerProfile`) is a future item.
4. **Single client leaf only.** werift sends one certificate, so the AC14K_M *fullchain*
   fallback (leaf + 4 CAs) cannot be presented. Only the self-signed single-leaf path is usable
   — which is the reference's default anyway.
5. **`onClose` fires on a peer alert**, so it can trigger reconnect; silent UDP drops need a
   keepalive (empty-CON ping), as the reference does.
6. **Packaging quirk:** `werift-dtls@0.5.8`'s published `main` (`lib/index.js`) is missing.
   Import `werift-dtls/lib/dtls/src/index.js`. The plugin isolates this in one transport module.
7. **PSK (0xC037) and legacy TCP 8888 are out of scope for v1** — see the transport seam.

## Decision

Native TypeScript Homebridge plugin. Transport seam at the OCF resource level
(`get`/`post`/`observe` on hrefs) so the PSK and 8888 paths can be added later. The
certificate path uses werift-dtls with the config above. Full appliance coverage is driven
by capability tables ported from `localthings`, validated against its captured fixtures and
its Python test oracles.


---

## ClientHello diff: werift vs the reference (OpenSSL), captured

Both captured on the wire (werift via the interop harness, Python via its
`DtlsCoapSession.connect` pointed at a loopback capture):

| | reference (OpenSSL default cert path) | werift-dtls 0.5.8 |
|---|---|---|
| record version | DTLS 1.0 (`feff`); body DTLS 1.2 | DTLS 1.2 (`fefd`) |
| cipher suites | **1**: `c02b` | **2**: `c02b`, `c02f` |
| supported_groups | x25519, P-256, x448, P-384, P-521 | x25519, P-256 |
| signature_algorithms | large set incl. SHA-1 | rsa_pkcs1_sha256, ecdsa_secp256r1_sha256 |
| ec_point_formats | **sent** (uncompressed) | not sent |
| session_ticket | **sent** (empty) | not sent |
| encrypt_then_mac | **sent** | not sent |
| extended_master_secret | **sent** | not sent |
| renegotiation_info | sent | sent |

Both offer the essential `ECDHE-ECDSA-AES128-GCM-SHA256` + P-256, which is the
Samsung certificate path, and a server that accepts OpenSSL's superset offer
will normally accept werift's subset. **Unverified risk:** if the appliance's
mbedTLS/TizenRT stack *requires* one of the four extensions werift omits —
most plausibly `extended_master_secret` or `ec_point_formats` — the handshake
could fail where the reference succeeds. This cannot be confirmed without a
physical appliance. werift HEAD (unpublished) does send extended_master_secret
when its option is set; if a real device rejects werift's offer, that is the
first lever.

## Correction: the reference DOES authenticate the appliance's certificate

An earlier draft said this plugin's no-server-pinning posture matches the
reference's default certificate path. **That is wrong.** The reference's
`CertificateAuth` (no profile) calls `load_verify_locations(ocf_root_ca.pem)`
and `set_verify(VERIFY_PEER, _verify_peer)`, where `_verify_peer` returns
OpenSSL's own result unchanged — so by default it **requires the appliance's
server certificate to chain to the bundled Samsung OCF root CA**, and the
handshake fails otherwise.

werift-dtls 0.5.8 performs **no** server-certificate verification, and its
client exposes only the leaf (`certificateList[0]`), discarding any
intermediates — so the plugin **cannot** replicate the reference's chain
verification on this library version. This is a real security downgrade
relative to the reference, documented in SECURITY.md and the README, and a
priority roadmap item (needs werift HEAD's `verifyRemoteCertificate`, which
receives the certificate, or a different DTLS library).


## Reverse interop: an independent client reads the simulator

The simulator (werift server + this project's CoAP/OCF response code) was driven
by the **real `smartthings-local` Python client** (OpenSSL DTLS), which completed
a client-certificate handshake and read `/device/0`: `2.05`, 8708 bytes, all 41
batch items reassembled via Block2. So the simulator's wire behaviour is checked
against an independent implementation, not only against this project's own
client. Harness: research/sim-interop/.
