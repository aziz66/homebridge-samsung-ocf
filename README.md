# homebridge-samsung-ocf

**Control Samsung appliances from HomeKit over your LAN — no Samsung/SmartThings cloud account.**

A native TypeScript Homebridge plugin that talks to Samsung's connected
appliances (washers, dryers, refrigerators, air conditioners, air purifiers,
ovens, dishwashers and more) directly on your local network, using the same
open standards the appliances implement: **OCF** resources over **CoAP /
DTLS 1.2** with an X.509 client certificate. After setup it never contacts
Samsung's servers.

It is the local replacement for cloud-based plugins such as
`homebridge-smartthings`, which route every command through Samsung's cloud and
a personal access token.

> ## ⚠️ Honesty first: what is and isn't verified
>
> This plugin was developed **without any physical Samsung appliance**. Read
> [Verified vs. unverified](#verified-vs-unverified) before relying on it.
>
> - **The DTLS transport is proven** (hardware-free) to speak the Samsung
>   certificate profile, by interop against an independent OpenSSL DTLS server.
> - **The whole stack is proven end-to-end against a simulator** built from
>   **real captured appliance data** (141 device captures).
> - **It has NOT been tested against a physical Samsung appliance.** In
>   particular, **write/command payloads are modelled, not confirmed on
>   hardware.** Reads are mapped from real captures.
> - **It does NOT verify the appliance's certificate** (a `werift-dtls@0.5.8`
>   limit), unlike the reference. See [Security](#security).

---

## How it works

```
HomeKit ⇄ Homebridge ⇄ homebridge-samsung-ocf
                           │  DTLS 1.2  (ECDHE-ECDSA-AES128-GCM-SHA256, P-256,
                           │             X.509 client cert — werift-dtls)
                           │  CoAP      (RFC 7252 + Observe 7641 + Block2 7959)
                           │  OCF/CBOR  (/oic/res, /oic/d, /device/0, …)
                           ▼
                    Samsung appliance on your LAN
```

- **Local & private.** No Samsung account, token, or internet round-trip after
  setup. The appliance keeps its own Samsung connection; this plugin doesn't
  change that.
- **Capability-driven.** The plugin inspects which OCF resources an appliance
  actually reports and maps them to HomeKit — it is not keyed on model strings.
- **Push + poll.** It subscribes to CoAP Observe where available and polls the
  full state on an interval; entities keep their last value across brief
  appliance disconnects, and it reconnects with backoff.

The protocol knowledge and the capability data come from the open-source
projects [mbillow/localthings](https://github.com/mbillow/localthings) (a Home
Assistant integration) and
[QuiteYellow/SmartThings-Local](https://github.com/QuiteYellow/SmartThings-Local)
(the protocol library). This plugin is an independent, native-TypeScript
reimplementation for Homebridge; it does not run their Python code.

---

## Install

> **Not yet published to npm.** Install from a packed tarball or from source:
> `npm run build && npm pack`, then `npm install -g ./homebridge-samsung-ocf-*.tgz`
> in your Homebridge environment. A published package and GitHub repo are a
> release step, not done here.

Then add the platform in the Homebridge UI (plugin name **SamsungOCF**) or in
`config.json`:

```json
{
  "platforms": [
    {
      "platform": "SamsungOCF",
      "pollIntervalMs": 30000,
      "appliances": [
        { "name": "Living Room AC", "host": "10.0.1.42", "port": 49154 },
        { "name": "Washer",         "host": "10.0.1.43" }
      ]
    }
  ]
}
```

- **`host`** — the appliance's LAN IP (give it a DHCP reservation).
- **`port`** — the appliance's OCF **secure (coaps) UDP port**. Optional: if
  omitted, the plugin discovers it from the appliance's plaintext `/oic/res`
  (the port varies per unit and after a power cycle). You can still set it
  explicitly to skip discovery.
- **`uuid`** (advanced) — override the authorizing certificate UUID. The
  default is the published constant that compatible appliances' on-device ACLs
  grant access to; you should not need to change it.
- **`allowRemoteOffWrites`** — by default a command is refused when the
  appliance reports *remote control off* (it would silently ignore it). Enable
  only if you confirm yours accepts commands anyway.

On first run the plugin mints an **RSA-2048 self-signed client certificate**
carrying the authorizing UUID (exactly as the reference `setup_cert.py` does —
nothing contacts an appliance or the cloud to make it) and stores it under
Homebridge's storage dir for reuse.

---

## What it maps to HomeKit

HomeKit's accessory model is much narrower than Home Assistant's, so this
plugin maps the **subset of each appliance's capabilities that HomeKit can
represent** and reports the rest honestly rather than inventing tiles.

| Appliance archetype | HomeKit |
|---|---|
| Air conditioner | **HeaterCooler** (power, current temperature, target state Auto/Heat/Cool, cooling/heating setpoints, fan speed, swing), **Lightbulb** (display light), optional-mode switches |
| Air purifier / air monitor | **AirPurifier** (power, state, fan speed), **AirQualitySensor** (air quality + PM2.5/PM10), **FilterMaintenance** |
| Washer / dryer / dishwasher | **Valve** cycle timer (Active, In-Use, remaining duration up to 4 h) |
| Refrigerator / freezer | **Thermostat** per zone — **writable** setpoint snapped to the device's supported values (discrete-setpoint boards) — and **ContactSensor** per door |
| Dehumidifier | **HumidifierDehumidifier** (writable target humidity) |
| Any appliance | **Switch** (power), **HumiditySensor**, **TemperatureSensor**, **ContactSensor** (doors), **FilterMaintenance** |

See **[docs/COVERAGE.md](docs/COVERAGE.md)** for a per-fixture breakdown across
141 real device captures, the HomeKit services produced, and — importantly —
the list of appliance capabilities that have **no HomeKit representation**
(cycle/course selection, mode enums, stateless buttons, time-of-day, free-form
status, firmware/diagnostics/config), so nothing is dropped silently.

HomeKit has no generic "select", "number", or washer service, so those
capabilities are intentionally not exposed. A HomeKit app that supports custom
characteristics (e.g. Eve) could surface more; that is on the roadmap.

---

## Verified vs. unverified

This is the honest status of every claim. Nothing here was tested on a physical
Samsung appliance.

### Verified (hardware-free)

- **DTLS handshake interop.** `werift-dtls` completes a DTLS 1.2 handshake with
  an **independent OpenSSL DTLS server** using the exact Samsung certificate
  profile — cipher `ECDHE-ECDSA-AES128-GCM-SHA256`, curve **P-256**, an RSA-2048
  **client certificate** that OpenSSL cryptographically validates (with a
  negative control proving it rejects the wrong trust anchor), fragmented
  server-certificate reassembly, and bidirectional application data. Rerun it
  yourself: `cd research/interop && npm i && ./run.sh`. Full write-up:
  [research/DTLS-WERIFT-FINDINGS.md](research/DTLS-WERIFT-FINDINGS.md).
- **CoAP wire format.** The codec is checked **byte-for-byte** against golden
  vectors emitted by the reference Python encoder.
- **End-to-end stack.** DTLS → CoAP (incl. Block2 reassembly of the large
  `/device/0` batch) → OCF discovery → capability engine → HAP accessory, all
  exercised against an in-process **simulated appliance that serves real
  captured fixtures**, including a full run through the real Homebridge platform
  and real `hap-nodejs` (zero characteristic warnings), two-appliance
  (multi-device) operation, and reconnection from a cold start, a mid-session
  drop, and a sustained outage. A corpus-wide sweep asserts zero HomeKit
  characteristic warnings across all 141 fixtures. 70+ automated tests; routing,
  read values and write payloads are gated against the reference.
- **Read mapping.** Current temperature, power, humidity, door state, setpoints
  etc. are parsed from **real appliance captures**.

### NOT verified

- **No physical appliance has ever been contacted by this plugin.** Interop is
  proven against OpenSSL, not against Samsung's TizenRT/mbedTLS firmware, which
  may differ in handshake-cookie handling, retransmission timing, or the
  half-open-peer quirk the reference library handles.
- **Writes/commands are modelled, not confirmed.** The exact resource, field
  and CBOR encoding each appliance accepts for a write has not been verified on
  hardware. The simulator accepts and records writes; a real appliance may
  reject or ignore them. Treat all command behaviour as experimental.
- **Secure-port auto-discovery, PSK appliances, and the legacy TCP-8888
  family are not implemented** (see [Roadmap](#roadmap)).
- **No appliance-certificate verification (a downgrade vs. the reference).** The
  reference verifies the appliance's server certificate against a bundled Samsung
  OCF root CA by default and fails the handshake otherwise; `werift-dtls@0.5.8`
  does no server verification and exposes only the leaf certificate, so this
  plugin cannot replicate that check on this library version. A hostile device at
  the configured LAN IP could impersonate the appliance. Mitigation: LAN-only,
  user-supplied IP. Fixing it is a priority roadmap item. See [Security](#security).

If you own a Samsung appliance and can test, issue reports (especially whether
commands take effect) are the most valuable contribution.

---

## Security

- **LAN only.** The plugin connects to an IP you configure on your local
  network. It opens no listening socket and exposes nothing to the internet.
- **No cloud, no account, no token.** Unlike cloud plugins, no Samsung
  credential is stored or transmitted.
- **Client key** is generated locally (RSA-2048), stored `chmod 600` under the
  Homebridge storage directory, and never leaves the host. The authorizing
  **UUID is a published constant**, not a secret — it identifies a cloud service
  role the appliances' ACLs grant; possessing it grants LAN access to an
  appliance you can already reach, nothing more.
- **No appliance authentication (a real downgrade vs. the reference).** The
  reference's default certificate path verifies the appliance's server
  certificate against a bundled Samsung OCF root CA; this plugin does **not**,
  because `werift-dtls@0.5.8` performs no server verification and discards the
  certificate chain's intermediates. A hostile device at the configured LAN IP
  could therefore impersonate the appliance. Acceptable only on a trusted LAN;
  tracked in SECURITY.md and the roadmap.
- **Write guard.** Commands are refused by default when the appliance reports
  remote control off. The plugin never touches the appliance's `/oic/sec/*`
  security resources.
- **Shipped dependencies have no known vulnerabilities** (`npm audit
  --omit=dev` → 0). Dev-only tooling is not shipped (the `files` whitelist ships
  `dist/` only).

---

## Development

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest: hardware-free test suite (50+ tests)
npm run typecheck
```

- The DTLS/CoAP/OCF/registry/HAP layers each have unit and/or integration tests
  under `test/`. The appliance **simulator** is in `test/sim/`; it serves real
  captured fixtures over DTLS/CoAP (reads replay captures; writes/observe are
  modelled — labelled as such).
- `research/` holds the transport decision and the rerunnable OpenSSL interop
  harness, plus the capability **oracle** (`research/oracle/`) used to generate
  the coverage report.
- Architecture, layer by layer: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Roadmap

In rough priority order, all currently **not implemented**:

1. **Appliance-certificate verification.** Match the reference's check (server
   cert chains to the bundled Samsung OCF root CA). Needs werift HEAD's
   `verifyRemoteCertificate` (which receives the certificate) or another DTLS
   library; `werift-dtls@0.5.8` discards the chain.
2. **More device archetypes** (oven/microwave cook state, robot vacuum, water
   purifier filter life, soundbar/TV where OCF-exposed) and **energy metering**
   via Eve custom characteristics.
3. **PSK appliances** — the newer OCF-PKI laundry generation authenticates with
   `ECDHE-PSK-AES128-CBC-SHA256` (0xC037), which no current TypeScript DTLS
   library negotiates; it needs a bespoke DTLS-PSK client (the reference wrote
   one in Python). The transport seam is in place for it.
4. **Legacy TCP-8888 appliances** (~2018–2022) over plain Node `tls`.
5. **Hardware validation** — confirm handshake, reads, and especially **writes**
   on real appliances, then promote write support out of "experimental".

---

## Trademarks & disclaimer

Independent, unofficial project. **Not affiliated with, authorized, endorsed, or
sponsored by Samsung Electronics Co., Ltd.** "Samsung" and "SmartThings" are
trademarks of their owner, used here only nominatively to identify the hardware
and protocols this software interoperates with. For use with appliances you own,
on your own network. MIT licensed, no warranty.
