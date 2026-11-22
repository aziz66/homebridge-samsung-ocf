import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import hap from "hap-nodejs";
import { buildServices } from "../../src/registry/engine";
import { parseDevice0Batch, deviceTypesFrom } from "../../src/ocf/discovery";
import { applyServices, type DeviceLike, type Logger } from "../../src/homekit/accessory";
import type { StateMap } from "../../src/registry/types";

const FIX = join(__dirname, "..", "fixtures", "samsung");
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
class FakeDevice extends EventEmitter implements DeviceLike {
  allowRemoteOffWrites = true;
  constructor(public state: StateMap) { super(); }
  async write() { return true; }
}

describe("no HAP characteristic warnings across the whole corpus", () => {
  it("every fixture builds an accessory with zero characteristic warnings (reads + a push)", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(FIX).filter((n) => n.endsWith("_device.json"))) {
      const name = f.replace("_device.json", "");
      const d = JSON.parse(readFileSync(join(FIX, f), "utf8"));
      const state: StateMap = new Map(Object.entries(parseDevice0Batch(d.device0)));
      const specs = buildServices(state, deviceTypesFrom(state.get("/oic/d")), { optionalModes: ["Sleep", "Speed"] }).services;
      const acc = new hap.Accessory(name, hap.uuid.generate("sweep:" + name));
      const warnings: string[] = [];
      acc.on("characteristic-warning" as never, (w: { message?: string; originatorChain?: string[] }) =>
        warnings.push(name + " :: " + (w.originatorChain?.join("/") ?? "") + " :: " + (w.message ?? "")));
      applyServices(hap as never, acc as never, specs, new FakeDevice(state) as never, silent);
      new FakeDevice(state); // noop
      // force a push re-evaluation of every char
      const dev = new FakeDevice(state);
      applyServices(hap as never, acc as never, [], dev as never, silent); // no-op, keep acc
      dev.emit("update", "x", {});
      if (warnings.length) offenders.push(...warnings);
    }
    if (offenders.length) console.error("HAP WARNINGS:\n" + offenders.slice(0, 40).join("\n"));
    expect(offenders).toEqual([]);
  }, 30000);
});
