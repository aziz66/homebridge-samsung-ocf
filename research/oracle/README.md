# Capability oracle

`oracle.json` is the ground-truth yardstick for this plugin's coverage. It is produced by
running the **real localthings registry** (commit f86a819c4371) over its 141 captured
device fixtures, entirely offline (no Home Assistant, no hardware): for each fixture it
records the resolved device registry, the bound entities, their HA descriptor kinds, and the
flattened state keys + values.

It is the denominator for the HomeKit coverage matrix in `docs/COVERAGE.md`, and a source of
truth for the read-value transforms the TypeScript engine reproduces (the TS registry tests
assert against these values).

## Regenerate
```sh
# needs a clone of mbillow/localthings at the recorded commit next to this repo,
# and python3.13 (the registry subtree is HA-free; gen_oracle.py builds a standalone
# import tree from it). See the script header.
python3.13 gen_oracle.py <localthings>/tests/fixtures oracle.json
```
Total: 141 fixtures, 5112 bound entities. Kinds: SensorDesc 2249, SwitchDesc 856,
BinarySensorDesc 827, SelectDesc 515, ButtonDesc 344, NumberDesc 173, TimeDesc 74,
LightDesc 32, ClimateDesc 28, FanDesc 9, ZoneClimateDesc 3, WaterHeaterDesc 2.
