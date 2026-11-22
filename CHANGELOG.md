# Changelog

## 0.1.0 — 2026-11-22

Initial release. A native TypeScript Homebridge plugin for **local** control of
Samsung OCF/SmartThings appliances over DTLS/CoAP/OCF — **no Samsung cloud
account**.

**Built and validated entirely without a physical Samsung appliance.** See the
README "Verified vs. unverified" section and SECURITY.md before relying on it —
in particular, write/command behaviour is modelled against the reference and has
**not** been confirmed on hardware.

### Supported (capability-driven, mapped to HomeKit)
- Air conditioner → HeaterCooler (power, temperature, mode, setpoints, fan speed,
  swing), display light, optional-mode switches, Fahrenheit handling.
- Air purifier / air monitor → AirPurifier, AirQualitySensor (PM2.5/PM10),
  FilterMaintenance.
- Washer / dryer / dishwasher → Valve cycle timer (active, in-use, remaining
  duration, running contact).
- Refrigerator → writable Thermostat per zone, ContactSensor per door.
- Dehumidifier → HumidifierDehumidifier (writable target humidity).
- Generic → power switch, temperature/humidity sensors, door contacts, filters.

### Engineering
- DTLS verified against an independent OpenSSL server; the simulator is verified
  by the real `smartthings-local` Python client (see `research/`).
- Device routing, read values and write payloads are gated against the reference
  (`mbillow/localthings`) over 141 captured device fixtures.
- 79 hardware-free tests, including a whole-corpus sweep asserting zero HomeKit
  characteristic warnings.

Not implemented: PSK (OCF-PKI) and legacy TCP-8888 appliances; appliance
server-certificate verification; full coverage of enum/select capabilities HomeKit
cannot represent.
