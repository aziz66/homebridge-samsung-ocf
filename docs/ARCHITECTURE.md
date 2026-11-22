# Architecture

Layered, bottom-up. Each layer has a narrow interface and its own tests; the
transport seam is at the OCF resource level so alternative auth/transports
(PSK, legacy TCP-8888) can slot in later.

```
src/
  coap/message.ts     RFC 7252 wire codec (encode/decode, options, Block helpers).
                      Validated byte-for-byte vs the reference Python encoder.
  coap/session.ts     CoAP over a datagram link: token/MID correlation, read
                      retransmit (writes once), token-stable Block2 reassembly,
                      separate-response ACK, RFC 7641 Observe w/ 24-bit seq
                      dedup, request pacing.
  dtls/transport.ts   DTLS 1.2 client over werift-dtls with the verified Samsung
                      certificate profile + its own handshake deadline. Isolates
                      the werift import quirk. Satisfies CoapSession's DatagramLink.
  ocf/cbor.ts         cbor-x wrapper (standard CBOR, plain objects).
  ocf/discovery.ts    parse the /device/0 batch (+ stub detection), /oic/res
                      links, device types from /oic/d.
  ocf/device.ts       OcfDevice: connect → discover → state cache → poll +
                      Observe → write → single-flight reconnect (1s→30s). Emits
                      online/offline/update. coapTimeoutMs/rateLimitRps options.
  ocf/portdiscovery.ts Plaintext /oic/res secure-port discovery (optional port).
  auth/cert.ts        Mint the RSA-2048 self-signed client cert (reference
                      CLIENT_UUID, memmem-locatable subject). ECDSA server cert
                      for the simulator. No cloud, no appliance contact.
  registry/
    resolve.ts        Device-family routing ported from the reference, gated to
                      match its registry on every recognized fixture.
    types.ts          Platform-agnostic HomeKit ServiceSpec/CharSpec/WriteOp.
    parse.ts          Samsung value parsing (strings → numbers, On/Off).
    engine.ts         Capability-driven OCF→HomeKit mapping: archetype
                      detection + matchers. Produces ServiceSpecs + mappedHrefs.
  homekit/accessory.ts  Binds ServiceSpecs to real hap-nodejs services:
                      onGet from state, onSet → OCF write with remote-control
                      guard, push on 'update'. Value clamp + seed-before-setProps.
  platform.ts         Homebridge DynamicPlatformPlugin: one accessory per
                      configured appliance; persisted client cert.
  index.ts            registerPlatform entry.

test/
  unit/               CoAP goldens, capability engine over all fixtures,
                      coverage report generator.
  integration/        DTLS, CoAP/OCF, OcfDevice, HAP accessory, and the full
                      platform↔simulator vertical slice.
  sim/                The simulated appliance (DTLS server + CoAP/OCF responder
                      serving real captures). TEST FIXTURE, not an interop oracle.
  fixtures/samsung/   141 real device captures (from mbillow/localthings, MIT).

research/
  DTLS-WERIFT-FINDINGS.md   Transport decision + the OpenSSL interop evidence.
  interop/                  Rerunnable werift↔OpenSSL harness (needs openssl).
  oracle/                   gen_oracle.py + oracle.json: the reference's own
                            entity output per fixture, the coverage denominator.
```

## Why this shape

- **Transport seam at get/post/observe**, not at DTLS datagrams, so the PSK and
  TCP-8888 paths can be added as alternative `DatagramLink`/session providers
  without touching the OCF, registry or HomeKit layers.
- **Platform-agnostic ServiceSpecs** let the capability engine be tested with no
  Homebridge/hap dependency, while the thin accessory layer is tested against
  real hap-nodejs.
- **Oracle-driven coverage + gating.** The reference registry is run (offline, no
  Home Assistant) over the same fixtures to produce the ground-truth entity set.
  Device routing is gated to match it exactly; AC read values and write payloads
  are gated against the reference's own logic; the coverage report measures the
  HomeKit mapping against it so gaps are explicit.
- **Non-circular wire validation.** Two independent-peer checks sit outside the
  test suite: our werift client ↔ OpenSSL server (research/interop), and the real
  Python smartthings-local client ↔ this simulator (research/sim-interop). The
  CoAP codec and CBOR encoder are byte-gold-tested against the Python/cbor2 output.
```
