#!/usr/bin/env bash
# werift-dtls <-> OpenSSL DTLS interop harness.
# Proves (hardware-free) that werift-dtls speaks the Samsung certificate DTLS profile:
# DTLS 1.2, ECDHE-ECDSA-AES128-GCM-SHA256, P-256, RSA-2048 client cert, app data.
# Requires: node + "npm i werift-dtls@0.5.8" in this dir, and openssl with DTLS.
# This is NOT part of the hardware-free unit suite (it needs an external openssl server);
# it is a reproducible transport-interop check. See DTLS-WERIFT-FINDINGS.md.
set -uo pipefail
cd "$(dirname "$0")"
[ -f certs/server.crt ] || ./gen-certs.sh
PASS=0; FAIL=0
run() { # name port groups cafile vre feed mtu certfile keyfile
  local name=$1 port=$2 groups=$3 cafile=$4 vre=$5 feed=$6 mtu=$7 certf=${8:-server.crt} keyf=${9:-server.key}
  local g=""; [ -n "$groups" ] && g="-groups $groups"
  local v=""; [ "$vre" = "1" ] && v="-verify_return_error"
  local stdin="sleep 12"; [ "$feed" = "1" ] && stdin="{ sleep 3; printf 'SRV-REPLY\n'; sleep 7; }"
  ( cd certs && eval "$stdin" | timeout 14 openssl s_server -dtls1_2 \
      -cipher 'ECDHE-ECDSA-AES128-GCM-SHA256@SECLEVEL=0' $g \
      -cert "$certf" -key "$keyf" -Verify 1 -CAfile "$cafile" $v -mtu "$mtu" \
      -accept "$port" -state > "../s_$port.log" 2>&1 ) &
  local spid=$!
  sleep 1
  CKEY=client_pk8.key timeout 12 node client.cjs "$port" > "c_$port.log" 2>&1 || true
  sleep 0.4; kill "$spid" 2>/dev/null || true; wait "$spid" 2>/dev/null || true
  echo "--- $name (port $port) ---"
  grep -q 'connected=true' "c_$port.log" && local conn=yes || local conn=no
  grep -q '1 server accepts that finished' "s_$port.log" && local fin=yes || local fin=no
  echo "  werift connected=$conn ; server handshake finished=$fin"
  grep -m1 -E 'subject=.*uuid' "s_$port.log" | sed 's/^/  /' || true
  grep -m1 -E 'RECV|unknown CA|verify error' "c_$port.log" "s_$port.log" | sed 's/^/  /' || true
}
echo "== positive: P-256, enforced client-cert validation, bidirectional app data =="
run pos 15100 secp256r1 client.crt 1 1 1200
echo "== negative: wrong CA -> server must reject werift's client cert =="
run neg 15101 secp256r1 server.crt 1 0 1200
echo "== x25519 completion =="
run x25519 15110 "" client.crt 1 1 1200
echo "== fragmented server cert chain (mtu 500) =="
run frag 15120 secp256r1 client.crt 1 0 500 chain.crt leaf.key
echo "done. Review the per-port logs for detail."
