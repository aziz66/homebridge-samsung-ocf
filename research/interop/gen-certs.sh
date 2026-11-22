#!/usr/bin/env bash
# Generate self-signed test certificates for the werift<->OpenSSL DTLS interop harness.
# These mirror the Samsung cert path: an ECDSA P-256 "appliance" (server) cert and an
# RSA-2048 self-signed "client" cert carrying a uuid in OU+CN (as setup_cert.py does).
# NOTHING here touches a real appliance; all keys are throwaway.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs && cd certs
UUID=${UUID:-11111111-2222-3333-4444-555555555555}

# ECDSA P-256 server (appliance) leaf, self-signed
openssl ecparam -name prime256v1 -genkey -noout -out server.key
openssl req -x509 -new -key server.key -sha256 -days 2 \
  -subj "/C=KR/O=Samsung Electronics/OU=OCF HA Device/CN=appliance" -out server.crt

# RSA-2048 client cert carrying the uuid (self-signed); PKCS#8 form for werift
openssl genrsa -out client.key 2048
openssl req -x509 -new -key client.key -sha256 -days 2 \
  -subj "/OU=uuid:$UUID/CN=uuid:$UUID" -out client.crt
openssl pkcs8 -topk8 -nocrypt -in client.key -out client_pk8.key

# ECDSA CA -> leaf chain, to exercise fragmented server-Certificate reassembly
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 2 \
  -subj "/C=KR/O=Samsung Electronics/OU=OCF HA Device/CN=Samsung OCF CA" -out ca.crt
openssl ecparam -name prime256v1 -genkey -noout -out leaf.key
openssl req -new -key leaf.key \
  -subj "/C=KR/O=Samsung Electronics/OU=OCF HA Device/CN=appliance-leaf" -out leaf.csr
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 2 -out leaf.crt
cat leaf.crt ca.crt > chain.crt
echo "certs generated in $(pwd)"
