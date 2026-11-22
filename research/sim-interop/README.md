# Reverse interop: real Python client ↔ this simulator

Proves (hardware-free) that the test **simulator**'s DTLS server + CoAP/OCF/Block2
response assembly interoperate with an **independent** client — the real
`smartthings-local` Python library over OpenSSL — not just with this project's
own TypeScript client. Together with research/interop/ (our werift client ↔
OpenSSL server), both directions of the wire are checked against OpenSSL.

## Result (recorded)
The Python `DtlsCoapSession` completes a client-certificate DTLS handshake with
`sim-runner.cjs` and reads `/device/0`: `2.05`, 8708 bytes, all 41 batch items
reassembled over Block2.

## Run
```sh
# from the project root: npm run build first
node research/sim-interop/sim-runner.cjs <ecdsa-server-cert.pem> <pkcs8-key.pem> <fixture_device.json>
# note the SIM_PORT it prints, then with a venv that has smartthings-local + cbor2:
python research/sim-interop/py_client.py <SIM_PORT> x <same-server-cert.pem>
```
The server cert must be ECDSA P-256 with a PKCS#8 key; the Python client is
pointed at it as its trust anchor (it stands in for the Samsung OCF root CA the
real library verifies against — see DTLS-WERIFT-FINDINGS.md).
