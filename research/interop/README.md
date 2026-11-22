# werift-dtls ↔ OpenSSL DTLS interop harness

Reproducible, **hardware-free** proof that `werift-dtls` speaks the DTLS profile Samsung
OCF appliances require on the certificate path. See [../DTLS-WERIFT-FINDINGS.md](../DTLS-WERIFT-FINDINGS.md).

## Run
```sh
npm i                 # installs werift-dtls@0.5.8
./run.sh              # generates throwaway certs, runs the interop cases
```
Requires `openssl` built with DTLS (OpenSSL 3.x) and Node ≥ 16.

## What it checks
- A full DTLS 1.2 handshake between the werift client and an **independent** OpenSSL
  DTLS server, cipher `ECDHE-ECDSA-AES128-GCM-SHA256`, curve **P-256** (and x25519).
- OpenSSL **enforces** client-certificate validation (`-Verify 1 -verify_return_error`):
  the positive case accepts werift's RSA-2048 client cert and finishes; the negative
  case (wrong trust anchor) is rejected with `unknown CA` and werift does not connect.
- Bidirectional application data over the established channel.
- Reassembly of a fragmented multi-certificate server flight (`-mtu 500`).

## Important
`werift-dtls@0.5.8`'s published `main` (`lib/index.js`) is missing; import the real entry:
`require('werift-dtls/lib/dtls/src/index.js')`. This is handled in `client.cjs` and
documented in the findings.

This harness is **not** part of the plugin's `npm test` (it needs an external openssl
server). It is the outside oracle for the DTLS transport layer.
