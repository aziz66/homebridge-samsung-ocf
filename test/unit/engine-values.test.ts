import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch, deviceTypesFrom } from "../../src/ocf/discovery";
import type { StateMap } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
const ORACLE = JSON.parse(readFileSync(join(__dirname, "..", "..", "research", "oracle", "oracle.json"), "utf8")).fixtures;
function stateOf(name: string): StateMap {
  const d = JSON.parse(readFileSync(join(FIX, `${name}_device.json`), "utf8"));
  return new Map(Object.entries(parseDevice0Batch(d.device0)));
}

describe("engine read values vs oracle", () => {
  it("AC current temperature and humidity equal the reference", () => {
    const name = "airconditioner_tp1x_da_ac_rac_01011";
    const s = stateOf(name);
    const r = buildServices(s, deviceTypesFrom(s.get("/oic/d")));
    const oracle = ORACLE[name].state as Record<string, unknown>;
    const hc = r.services.find((x) => x.service === "HeaterCooler")!;
    const cur = hc.chars.find((c) => c.char === "CurrentTemperature")!.get!(s);
    expect(cur).toBe(oracle["current_temperature_c"]); // 17
    const humSvc = r.services.find((x) => x.service === "HumiditySensor");
    expect(humSvc).toBeDefined();
    const hum = humSvc!.chars[0].get!(s);
    expect(hum).toBe(oracle["humidity"]); // 53 (fivepercentHumidity), not the raw 0

    // FilterMaintenance life level = 100 - reference air_filter_usage (42) = 58
    const filter = r.services.find((x) => x.service === "FilterMaintenance");
    expect(filter).toBeDefined();
    const life = filter!.chars.find((c) => c.char === "FilterLifeLevel")!.get!(s);
    expect(life).toBe(100 - (oracle["air_filter_usage"] as number)); // 58
    const indic = filter!.chars.find((c) => c.char === "FilterChangeIndication")!.get!(s);
    expect(indic).toBe(oracle["air_filter_status"] === "normal" ? 0 : 1);

    // RotationSpeed exists on the HeaterCooler (wind/strength index 0 → 0%)
    const speed = hc.chars.find((c) => c.char === "RotationSpeed");
    expect(speed).toBeDefined();
    expect(speed!.get!(s)).toBe(0);
  });
});
