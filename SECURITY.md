# Security review

Hardware-free security review of homebridge-samsung-ocf. This is a **local
control** plugin for Samsung OCF appliances the user owns, on their own LAN. It
holds no Samsung cloud credentials and opens no inbound/public socket.

## Threat model

- **Trusted LAN.** The plugin connects to an IP the user configures on their
  local network. It assumes the LAN is trusted; it is not designed to be safe
  against a hostile device already on the LAN (see finding 1).
- **No internet exposure.** No listening socket, no port opened, nothing
  reachable from outside the host. Outbound DTLS only, to the configured IP.
- **No cloud, no account.** Unlike cloud plugins, no Samsung token or account
  credential is stored or transmitted.

## Findings

### 1. No appliance-certificate verification (important; downgrade vs. the reference)

The reference (`smartthings-local`) verifies the appliance's **server**
certificate against a bundled Samsung OCF root CA by default
(`load_verify_locations(ocf_root_ca.pem)` + `VERIFY_PEER`) and fails the
handshake if it does not chain. This plugin uses `werift-dtls@0.5.8`, which
performs **no** server-certificate verification and exposes only the leaf
certificate (discarding intermediates), so it **cannot** replicate that check
on this library version.

- **Impact:** a hostile device at the configured LAN IP could impersonate the
  appliance and receive the DTLS session (which carries no cloud credential, but
  could feed false state to HomeKit or absorb commands).
- **Mitigation today:** LAN-only, user-supplied IP; the client certificate the
  plugin presents only grants access to an appliance the user can already reach.
- **Fix (roadmap):** werift HEAD adds a `verifyRemoteCertificate` hook that
  receives the certificate; switching to it (or another DTLS library that
  surfaces the chain) lets the plugin verify against the OCF root CA. Tracked in
  the README roadmap.

### 2. Client private key at rest (handled)

Minted locally (RSA-2048), written `chmod 600` under the Homebridge storage
directory, never transmitted. The authorizing **UUID is a published constant**,
not a secret — it identifies a Samsung cloud service role that compatible
appliances' ACLs grant; it gives LAN access only to an appliance already in
reach. Rotating the local key does not change access (the UUID authorizes).

### 3. Config-value injection (handled)

The optional per-appliance `uuid` becomes part of a certificate subject **and a
file path** (`client-<uuid>.json`). `assertValidUuid` rejects anything that is
not a 8-4-4-4-12 hex UUID before it reaches either, preventing path traversal
and subject injection (tested in robustness.test.ts).

### 4. Command/write guard (handled)

A write is refused by default when the appliance reports remote control off
(`requiresRemoteControl` + `remoteControlOff`), surfaced as an error rather than
a silent no-op; the operator can opt in per appliance. The plugin never writes
to the appliance's `/oic/sec/*` security resources.

### 5. Dependency surface (handled)

Shipped (runtime) dependencies have **no known vulnerabilities** (`npm audit
--omit=dev` → 0). The `files` whitelist ships `dist/` only; dev tooling
(Homebridge, vitest) is not published. `werift-dtls@0.5.8`'s broken package
`main` is isolated to one transport module.

### 6. Secure-port discovery (informational)

Discovery sends an unauthenticated plaintext CoAP GET to `<host>:5683` and reads
only the public `/oic/res` directory. It authenticates nothing and is used only
to find the DTLS port; the DTLS session then does the real work. It is unicast
to the configured host (no multicast).

### 7. Captured fixtures (informational)

`test/fixtures/samsung/` holds real device captures from the upstream project,
which redacts personal and network data (account, tokens, MACs, serials, SSID,
names) but keeps the OCF device ID, which upstream documents as non-sensitive
(it grants no access). No live credentials are committed. The werift interop
harness uses only throwaway self-signed test certificates.

## Test isolation

All automated tests run on 127.0.0.1 with ephemeral ports and an in-process
simulator; none send traffic onto the LAN or to any appliance. The werift↔
OpenSSL interop harness is loopback-only and not part of `npm test`.
