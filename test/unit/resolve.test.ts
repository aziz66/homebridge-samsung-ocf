import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveKey } from "../../src/registry/resolve";
import { parseDevice0Batch, deviceTypesFrom } from "../../src/ocf/discovery";

const FIX = join(__dirname, "..", "fixtures", "samsung");
const ORACLE = join(__dirname, "..", "..", "research", "oracle", "oracle.json");

describe("device routing matches the reference oracle", () => {
  it("resolveKey equals the reference registry for every fixture it recognizes", () => {
    const oracle = JSON.parse(readFileSync(ORACLE, "utf8")).fixtures as Record<string, { registry: string | null }>;
    const mismatches: string[] = [];
    let checked = 0;
    for (const f of readdirSync(FIX).filter((n) => n.endsWith("_device.json"))) {
      const name = f.replace("_device.json", "");
      const o = oracle[name];
      if (!o || o.registry === null || o.registry === undefined) continue; // oracle used the global fallback
      const d = JSON.parse(readFileSync(join(FIX, f), "utf8"));
      const state = new Map(Object.entries(parseDevice0Batch(d.device0)));
      const dtypes = deviceTypesFrom(state.get("/oic/d"));
      const key = resolveKey(state, dtypes);
      checked++;
      if (key !== o.registry) mismatches.push(`${name}: got ${key ?? "none"}, oracle ${o.registry}`);
    }
    if (mismatches.length) console.error("ROUTING MISMATCHES:\n" + mismatches.join("\n"));
    expect({ checked, mismatches }).toMatchObject({ mismatches: [] });
    expect(checked).toBeGreaterThan(100);
  });
});
