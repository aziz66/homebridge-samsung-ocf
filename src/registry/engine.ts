/**
 * Capability-driven OCF → HomeKit mapping engine.
 *
 * It inspects the resource state (which resources/fields are present), not a
 * model string, and emits platform-agnostic ServiceSpecs. An appliance
 * archetype (ac / air_purifier / laundry / fridge / generic) picks the primary
 * HomeKit service; generic matchers add companion sensors and controls.
 *
 * HomeKit cannot represent every Samsung capability (it has no generic
 * select/enum, duration, or washer service). What maps is mapped; what cannot
 * is reported by the coverage tooling (docs/COVERAGE.md), never dropped silently.
 *
 * WRITE PAYLOADS ARE MODELLED, NOT HARDWARE-VERIFIED. The read paths replay
 * real captures; the exact write field/encoding each appliance accepts has not
 * been confirmed on a device. See docs/COVERAGE.md and README "Unverified".
 */
import type { BuildResult, CharSpec, Rep, ServiceSpec, StateMap, WriteOp } from "./types";
import { findRep, findReps, num, onOff, str } from "./parse";
import { resolveKey, keyToArchetype } from "./resolve";

const isVs0 = (base: string) => (href: string) => href === `/${base}/vs/0` || href === `/${base}/0`;

/** Does the appliance report remote control as OFF? Mirrors the reference's
 * remote_control_enabled: /remotectrl/0.value (bool), else
 * /remotectrl/vs/0.remoteControlEnabled == "true" (string/bool), default ON
 * (off=false) when neither resource is present. */
export function remoteControlOff(state: StateMap): boolean {
  const generic = state.get("/remotectrl/0");
  if (generic !== undefined) return !generic["value"];
  const vs = state.get("/remotectrl/vs/0");
  if (vs !== undefined) return String(vs["x.com.samsung.da.remoteControlEnabled"]).toLowerCase() !== "true";
  return false; // most device types don't report it; don't block
}

interface PowerRef { href: string; ocf: boolean; }
/** The power resource to use, preferring OCF /power/0 {value} over vendor
 * /power/vs/0 {x.com.samsung.da.power} — both are advertised while firmware
 * migrates, and the reference reads/writes the OCF one when present. */
function powerRef(state: StateMap): PowerRef | undefined {
  if (state.get("/power/0")) return { href: "/power/0", ocf: true };
  if (state.get("/power/vs/0")) return { href: "/power/vs/0", ocf: false };
  return undefined;
}
function readPower(state: StateMap, ref: PowerRef): boolean | undefined {
  const rep = state.get(ref.href);
  if (!rep) return undefined;
  if (ref.ocf) {
    const v = rep["value"];
    return typeof v === "boolean" ? v : onOff(v);
  }
  return onOff(rep["x.com.samsung.da.power"]);
}
function writePower(ref: PowerRef, on: boolean): WriteOp {
  return ref.ocf
    ? { href: ref.href, rep: { value: on }, requiresRemoteControl: true }
    : { href: ref.href, rep: { "x.com.samsung.da.power": on ? "On" : "Off" }, requiresRemoteControl: true };
}
function powerActiveChar(ref: PowerRef): CharSpec {
  return { char: "Active", get: (s) => (readPower(s, ref) ? 1 : 0), set: (v) => writePower(ref, v === 1 || v === true) };
}

/** AC/room first temperature item from /temperatures/vs/0. */
function firstTempItem(state: StateMap): { href: string; item: Rep } | undefined {
  const found = findRep(state, (h) => h.startsWith("/temperatures"));
  if (!found) return undefined;
  const items = found[1]["x.com.samsung.da.items"];
  if (Array.isArray(items) && items.length) return { href: found[0], item: items[0] as Rep };
  return undefined;
}

/** RotationSpeed (0-100%) mapped from a /wind/strength/vs/0 index resource. */
function fanRotationSpeedChar(state: StateMap, mapped: Set<string>): CharSpec | undefined {
  const wind = findRep(state, (h) => h === "/wind/strength/vs/0" || h.startsWith("/wind/strength"));
  if (!wind) return undefined;
  const supported = (wind[1]["x.com.samsung.da.supportedModes"] as string[]) ?? [];
  const n = supported.length;
  if (n < 2) return undefined;
  mapped.add(wind[0]);
  const step = 100 / (n - 1);
  return {
    char: "RotationSpeed",
    get: (s) => {
      const cur = str(s.get(wind[0])?.["x.com.samsung.da.modes"]);
      const idx = supported.indexOf(cur ?? "");
      return idx >= 0 ? Math.round(idx * step) : 0;
    },
    set: (v) => {
      const idx = Math.max(0, Math.min(n - 1, Math.round(Number(v) / step)));
      return { href: wind[0], rep: { "x.com.samsung.da.modes": supported[idx] }, requiresRemoteControl: true };
    },
    props: { minValue: 0, maxValue: 100, minStep: Math.round(step) },
  };
}

/** Refrigerator zone setpoints → a writable Thermostat per zone. The device
 * accepts only the discrete values in supportedList, so HomeKit writes are
 * snapped to the nearest supported value. Reference fridge.py DEFINITE_TEMPERATURE_*:
 * /temperature/definite/<zone>/vs/0 {x.com.samsung.da.definite.desired}. */
function buildFridge(state: StateMap, mapped: Set<string>): ServiceSpec[] {
  const out: ServiceSpec[] = [];
  for (const [href, r] of findReps(state, (h) => /^\/temperature\/definite\/[^/]+\/vs\/0$/.test(h))) {
    const desired = num(r["x.com.samsung.da.definite.desired"]);
    const list = (r["x.com.samsung.da.definite.supportedList"] as string[]) ?? [];
    const nums = list.map(Number).filter((n) => Number.isFinite(n));
    if (desired === undefined || nums.length < 1) continue;
    mapped.add(href);
    const zone = href.split("/")[3] ?? "zone"; // /temperature/definite/<zone>/vs/0
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const snap = (c: number): number => nums.reduce((best, n) => (Math.abs(n - c) < Math.abs(best - c) ? n : best), nums[0]);
    const readDesired = (s: StateMap) => num(s.get(href)?.["x.com.samsung.da.definite.desired"]);
    out.push({
      service: "Thermostat", subtype: href, name: zone.charAt(0).toUpperCase() + zone.slice(1),
      chars: [
        { char: "CurrentHeatingCoolingState", get: () => 2 }, // COOL (a fridge only cools)
        { char: "TargetHeatingCoolingState", get: () => 2, props: { validValues: [2] } },
        { char: "CurrentTemperature", get: readDesired, props: { minValue: -50, maxValue: 100, minStep: 0.1 } },
        {
          char: "TargetTemperature",
          get: readDesired,
          set: (v) => ({ href, rep: { "x.com.samsung.da.definite.desired": String(snap(Number(v))) }, requiresRemoteControl: true }),
          props: { minValue: min, maxValue: max, minStep: 1 },
        },
        { char: "TemperatureDisplayUnits", get: () => 0 }, // CELSIUS
      ],
      sourceHrefs: [href],
    });
  }

  // Most fridges instead report zones in /temperatures/vs/0 items[] with a live
  // "current" and a writable "desired" (+ minimum/maximum). Reference TEMP_SETPOINT:
  // /temperatures/vs/0 {items:[{id, desired}]}.
  const temps = state.get("/temperatures/vs/0");
  const items = temps && Array.isArray(temps["x.com.samsung.da.items"]) ? (temps["x.com.samsung.da.items"] as Rep[]) : [];
  items.forEach((item, idx) => {
    const desired = num(item["x.com.samsung.da.desired"]);
    const current = num(item["x.com.samsung.da.current"]);
    if (desired === undefined && current === undefined) return; // stub item
    mapped.add("/temperatures/vs/0");
    const id = str(item["x.com.samsung.da.id"]) ?? String(idx);
    const zone = str(item["x.com.samsung.da.description"]) ?? `Zone ${id}`;
    const fah = isFahrenheit(item["x.com.samsung.da.unit"]);
    const toC = (v: number | undefined): number | undefined => (v === undefined ? undefined : fah ? fToC(v) : v);
    const incr = num(item["x.com.samsung.da.increment"]) ?? 1;
    const rawMin = num(item["x.com.samsung.da.minimum"]);
    const rawMax = num(item["x.com.samsung.da.maximum"]);
    const minC = toC(rawMin) ?? -50;
    const maxC = toC(rawMax) ?? 100;
    const readItem = (s: StateMap): Rep | undefined => {
      const its = s.get("/temperatures/vs/0")?.["x.com.samsung.da.items"];
      return Array.isArray(its) ? ((its as Rep[]).find((x) => str(x["x.com.samsung.da.id"]) === id) ?? (its as Rep[])[idx]) : undefined;
    };
    out.push({
      service: "Thermostat", subtype: `/temperatures/vs/0#${id}`, name: zone,
      chars: [
        { char: "CurrentHeatingCoolingState", get: () => 2 },
        { char: "TargetHeatingCoolingState", get: () => 2, props: { validValues: [2] } },
        { char: "CurrentTemperature", get: (s) => toC(num(readItem(s)?.["x.com.samsung.da.current"]) ?? num(readItem(s)?.["x.com.samsung.da.desired"])), props: { minValue: -50, maxValue: 100, minStep: 0.1 } },
        {
          char: "TargetTemperature",
          get: (s) => toC(num(readItem(s)?.["x.com.samsung.da.desired"])),
          set: (v) => {
            const deviceVal = fah ? cToF(Number(v)) : Number(v);
            const q = Math.round(deviceVal / incr) * incr;
            return { href: "/temperatures/vs/0", rep: { "x.com.samsung.da.items": [{ "x.com.samsung.da.id": id, "x.com.samsung.da.desired": String(Number.isInteger(q) ? q : Number(q.toFixed(1))) }] }, requiresRemoteControl: true };
          },
          props: { minValue: Math.min(minC, maxC), maxValue: Math.max(minC, maxC), minStep: fah ? 0.5 : incr },
        },
        { char: "TemperatureDisplayUnits", get: () => 0 },
      ],
      sourceHrefs: ["/temperatures/vs/0"],
    });
  });
  return out;
}

/** AirQualitySensor + PM densities from /sensors/vs/0 items.
 * Dust=PM10, FineDust=PM2.5, SuperFineDust=PM1 (μg/m³); value[0]=concentration.
 * Applies to air purifiers, air monitors and range hoods that report it. */
function buildAirQuality(state: StateMap, mapped: Set<string>): ServiceSpec[] {
  const s = findRep(state, (h) => h === "/sensors/vs/0");
  if (!s) return [];
  const conc = (st: StateMap, type: string): number | undefined => {
    const items = st.get(s[0])?.["x.com.samsung.da.items"];
    if (!Array.isArray(items)) return undefined;
    const it = (items as Rep[]).find((i) => str(i["x.com.samsung.da.type"]) === type);
    const v = it?.["x.com.samsung.da.value"];
    return Array.isArray(v) ? num(v[0]) : undefined;
  };
  const pm25 = conc(state, "FineDust");
  const pm10 = conc(state, "Dust");
  if (pm25 === undefined && pm10 === undefined) return [];
  mapped.add(s[0]);
  // PM2.5 → HomeKit AirQuality (EPA-style μg/m³ breakpoints). Approximate; the
  // device's own grade band isn't a 1:1 HomeKit scale. 0=UNKNOWN.
  const band = (p: number | undefined): number =>
    p === undefined ? 0 : p <= 12 ? 1 : p <= 35 ? 2 : p <= 55 ? 3 : p <= 150 ? 4 : 5;
  const chars: CharSpec[] = [{
    char: "AirQuality",
    get: (st) => band(conc(st, "FineDust") ?? conc(st, "Dust")),
  }];
  if (pm25 !== undefined) chars.push({ char: "PM2_5Density", get: (st) => conc(st, "FineDust"), props: { minValue: 0, maxValue: 1000 } });
  if (pm10 !== undefined) chars.push({ char: "PM10Density", get: (st) => conc(st, "Dust"), props: { minValue: 0, maxValue: 1000 } });
  return [{ service: "AirQualitySensor", subtype: s[0], name: "Air Quality", chars, sourceHrefs: [s[0]] }];
}

/** FilterMaintenance from a /filter/… resource (status + usage %). */
function buildFilter(state: StateMap, mapped: Set<string>): ServiceSpec[] {
  const out: ServiceSpec[] = [];
  for (const [href, r] of findReps(state, (h) => h.startsWith("/filter/"))) {
    const usage = num(r["x.com.samsung.da.filterUsage"]);
    const status = str(r["x.com.samsung.da.filterStatus"]);
    if (usage === undefined && status === undefined) continue;
    // Skip a filter the device reports as not in use (e.g. an empty dishwasher
    // water-filter slot) — otherwise it shows a phantom "Change Filter".
    if (status && status.toLowerCase() === "notused") continue;
    mapped.add(href);
    const label = href.split("/").filter(Boolean).slice(1).filter((p) => p !== "vs" && p !== "0").join(" ") || "Filter";
    const ATTENTION = new Set(["replace", "change", "overused", "bad", "full", "used"]);
    const chars: CharSpec[] = [{
      char: "FilterChangeIndication",
      get: (s) => {
        // Only flag a real replacement state; "normal"/"prepare"/"washable" are OK.
        const st = str(s.get(href)?.["x.com.samsung.da.filterStatus"])?.toLowerCase();
        return st && ATTENTION.has(st) ? 1 : 0; // CHANGE_FILTER / FILTER_OK
      },
    }];
    if (usage !== undefined) {
      chars.push({
        char: "FilterLifeLevel",
        get: (s) => {
          const u = num(s.get(href)?.["x.com.samsung.da.filterUsage"]);
          return u === undefined ? undefined : Math.max(0, Math.min(100, 100 - u));
        },
        props: { minValue: 0, maxValue: 100, minStep: 1 },
      });
    }
    out.push({ service: "FilterMaintenance", subtype: href, name: label, chars, sourceHrefs: [href] });
  }
  return out;
}

/** Temperature-unit handling: HomeKit characteristics are always Celsius, so
 * convert when a Samsung resource reports Fahrenheit (x.com.samsung.da.unit). */
function isFahrenheit(unit: unknown): boolean {
  const u = typeof unit === "string" ? unit.trim().toLowerCase() : "";
  return u.startsWith("f") || u === "°f";
}
const fToC = (f: number): number => ((f - 32) * 5) / 9;
const cToF = (c: number): number => (c * 9) / 5 + 32;

const AC_MODE_TO_TARGET: Record<string, number> = { Auto: 0, Heat: 1, Cool: 2 }; // HAP AUTO/HEAT/COOL
const TARGET_TO_AC_MODE: Record<number, string> = { 0: "Auto", 1: "Heat", 2: "Cool" };

function buildAirConditioner(state: StateMap, mapped: Set<string>): ServiceSpec | undefined {
  const pwr = powerRef(state);
  const temps = firstTempItem(state);
  const mode = findRep(state, isVs0("mode"));
  if (!temps && !mode) return undefined;
  const sources: string[] = [];
  const chars: CharSpec[] = [];
  if (pwr) {
    chars.push(powerActiveChar(pwr));
    sources.push(pwr.href);
    mapped.add(pwr.href);
  }
  if (temps) {
    const th = temps.href;
    sources.push(th);
    mapped.add(th);
    const fahrenheit = isFahrenheit(temps.item["x.com.samsung.da.unit"]);
    const increment = num(temps.item["x.com.samsung.da.increment"]) ?? 1;
    const toC = (v: number | undefined): number | undefined => (v === undefined ? undefined : fahrenheit ? fToC(v) : v);
    const readItem = (s: StateMap): Rep | undefined => {
      const items = s.get(th)?.["x.com.samsung.da.items"];
      return Array.isArray(items) ? (items[0] as Rep) : undefined;
    };
    const rawMin = num(temps.item["x.com.samsung.da.minimum"]) ?? (fahrenheit ? 61 : 16);
    const rawMax = num(temps.item["x.com.samsung.da.maximum"]) ?? (fahrenheit ? 86 : 30);
    const min = fahrenheit ? Math.ceil(fToC(rawMin)) : rawMin;
    const max = fahrenheit ? Math.floor(fToC(rawMax)) : rawMax;
    chars.push({
      char: "CurrentTemperature",
      get: (s) => toC(num(readItem(s)?.["x.com.samsung.da.current"])),
      props: { minValue: -50, maxValue: 100, minStep: 0.1 },
    });
    // HomeKit gives Celsius; convert back to the device unit and quantize to its
    // increment, then stringify (as the reference _quantize_temperature does).
    const writeDesired = (homekitC: number): WriteOp => {
      const deviceVal = fahrenheit ? cToF(homekitC) : homekitC;
      const q = Math.round(deviceVal / increment) * increment;
      const s = Number.isInteger(q) ? String(q) : String(Number(q.toFixed(1)));
      return {
        href: th,
        rep: { "x.com.samsung.da.items": [{ "x.com.samsung.da.id": str(temps.item["x.com.samsung.da.id"]) ?? "0", "x.com.samsung.da.desired": s }] },
        requiresRemoteControl: true,
      };
    };
    for (const c of ["CoolingThresholdTemperature", "HeatingThresholdTemperature"]) {
      chars.push({
        char: c,
        get: (s) => toC(num(readItem(s)?.["x.com.samsung.da.desired"])),
        set: (v) => writeDesired(Number(v)),
        props: { minValue: min, maxValue: max, minStep: fahrenheit ? 0.5 : increment },
      });
    }
  }
  if (mode) {
    const mh = mode[0];
    sources.push(mh);
    mapped.add(mh);
    const supported = (mode[1]["x.com.samsung.da.supportedModes"] as string[]) ?? [];
    const valid = [...new Set(supported.map((m) => AC_MODE_TO_TARGET[m]).filter((n): n is number => n !== undefined))];
    chars.push({
      char: "TargetHeaterCoolerState",
      get: (s) => {
        const wm = str(s.get(mh)?.["workingMode"]) ?? (s.get(mh)?.["x.com.samsung.da.modes"] as string[] | undefined)?.[0];
        const computed = wm && AC_MODE_TO_TARGET[wm] !== undefined ? AC_MODE_TO_TARGET[wm] : (valid[0] ?? 0);
        // never return a value outside the advertised validValues (HAP warns)
        return valid.length && !valid.includes(computed) ? valid[0] : computed;
      },
      set: (v) => {
        const m = TARGET_TO_AC_MODE[Number(v)];
        return m ? { href: mh, rep: { "x.com.samsung.da.modes": [m] }, requiresRemoteControl: true } : null;
      },
      props: valid.length ? { validValues: valid.length ? valid : [0, 1, 2] } : undefined,
    });
    chars.push({
      char: "CurrentHeaterCoolerState",
      get: (s) => {
        const on = pwr ? readPower(s, pwr) : undefined;
        if (on === false) return 0; // INACTIVE
        const wm = str(s.get(mh)?.["workingMode"]);
        if (wm === "Heat") return 2; // HEATING
        if (wm === "Cool") return 3; // COOLING
        return 1; // IDLE
      },
    });
  }
  const fan = fanRotationSpeedChar(state, mapped);
  if (fan) chars.push(fan);
  // Swing (vane) from /wind/direction — matches the reference _climate_write
  // swing (/wind/direction/vs/0 {x.com.samsung.da.modes}); "Fix" = not swinging.
  const wd = findRep(state, (h) => h === "/wind/direction/vs/0");
  if (wd) {
    mapped.add(wd[0]);
    const supported = (wd[1]["x.com.samsung.da.supportedModes"] as string[]) ?? [];
    const swingOn = supported.includes("All") ? "All" : (supported.find((m) => m !== "Fix") ?? "All");
    chars.push({
      char: "SwingMode",
      get: (s) => { const m = str(s.get(wd[0])?.["x.com.samsung.da.modes"]); return m && m !== "Fix" ? 1 : 0; },
      set: (v) => ({ href: wd[0], rep: { "x.com.samsung.da.modes": v === 1 || v === true ? swingOn : "Fix" }, requiresRemoteControl: true }),
    });
  }
  return { service: "HeaterCooler", name: "Air Conditioner", primary: true, chars, sourceHrefs: sources };
}

function buildAirPurifier(state: StateMap, mapped: Set<string>): ServiceSpec | undefined {
  const pwr = powerRef(state);
  if (!pwr) return undefined;
  mapped.add(pwr.href);
  const chars: CharSpec[] = [
    powerActiveChar(pwr),
    {
      char: "CurrentAirPurifierState",
      get: (s) => (readPower(s, pwr) ? 2 : 0), // PURIFYING_AIR / INACTIVE
    },
    {
      char: "TargetAirPurifierState",
      get: () => 1, // AUTO
      set: () => null, // mode control is appliance-specific; left read-only here
    },
  ];
  const fan = fanRotationSpeedChar(state, mapped);
  if (fan) chars.push(fan);
  return { service: "AirPurifier", name: "Air Purifier", primary: true, chars, sourceHrefs: [pwr.href] };
}

/** Whether a laundry appliance is mid-cycle (running), from /operational/state. */
function laundryRunning(state: StateMap, opHref: string): boolean {
  const rep = state.get(opHref) ?? {};
  const st = (str(rep["currentMachineState"]) ?? str(rep["x.com.samsung.da.state"]) ?? "").toLowerCase();
  const progress = (str(rep["progress"]) ?? str(rep["x.com.samsung.da.progress"]) ?? "").toLowerCase();
  return st !== "" && !MACHINE_INACTIVE.has(st) && progress !== "finish";
}

/** Parse a "HH:MM:SS" (or bare-seconds) duration string to seconds. */
function parseHms(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  if (v.includes(":")) {
    const parts = v.split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return undefined;
    return parts.reduce((acc, n) => acc * 60 + n, 0); // H*3600 + M*60 + S
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** Machine states that are NOT "in use". Everything else (Run, Wash, Dry, …) is. */
const MACHINE_INACTIVE = new Set(["", "none", "ready", "finish", "finished", "pause", "paused", "off", "stop", "stopped", "idle"]);

/** Dehumidifier → HomeKit HumidifierDehumidifier (writable target humidity).
 * Reference dehumidifier.py HUMIDITY: /humidity/vs/0 {x.com.samsung.da.desiredHumidity}. */
function buildDehumidifier(state: StateMap, mapped: Set<string>): ServiceSpec | undefined {
  const hum = state.get("/humidity/vs/0");
  if (!hum) return undefined;
  mapped.add("/humidity/vs/0");
  const pwr = powerRef(state);
  if (pwr) mapped.add(pwr.href);
  const readHum = (s: StateMap) => {
    const r = s.get("/humidity/vs/0") ?? {};
    return num(r["x.com.samsung.da.humidity"]) ?? num(r["x.com.samsung.da.fivepercentHumidity"]);
  };
  const increment = num(hum["increment"]) ?? 5;
  const chars: CharSpec[] = [
    { char: "Active", get: (s) => (pwr && readPower(s, pwr) ? 1 : 0), set: pwr ? (v) => writePower(pwr, v === 1 || v === true) : undefined },
    { char: "CurrentRelativeHumidity", get: readHum, props: { minValue: 0, maxValue: 100 } },
    { char: "CurrentHumidifierDehumidifierState", get: (s) => (pwr && readPower(s, pwr) ? 3 : 0) }, // DEHUMIDIFYING / INACTIVE
    { char: "TargetHumidifierDehumidifierState", get: () => 2, props: { validValues: [2] } }, // DEHUMIDIFIER only
    {
      char: "RelativeHumidityDehumidifierThreshold",
      get: (s) => num(s.get("/humidity/vs/0")?.["x.com.samsung.da.desiredHumidity"]),
      set: (v) => ({ href: "/humidity/vs/0", rep: { "x.com.samsung.da.desiredHumidity": String(Math.round(Number(v))) }, requiresRemoteControl: true }),
      props: { minValue: 0, maxValue: 100, minStep: increment },
    },
  ];
  return { service: "HumidifierDehumidifier", name: "Dehumidifier", primary: true, chars, sourceHrefs: pwr ? ["/humidity/vs/0", pwr.href] : ["/humidity/vs/0"] };
}
function buildLaundry(state: StateMap, mapped: Set<string>): ServiceSpec | undefined {
  const op = findRep(state, (h) => h === "/operational/state/vs/0") ?? findRep(state, (h) => h.startsWith("/operational/state"));
  if (!op) return undefined;
  mapped.add(op[0]);
  const pwr = powerRef(state);
  if (pwr) mapped.add(pwr.href);
  const chars: CharSpec[] = [
    {
      char: "Active",
      get: (s) => (pwr && readPower(s, pwr) === false ? 0 : 1), // active unless power is explicitly off
      set: pwr ? (v) => writePower(pwr, v === 1 || v === true) : undefined,
    },
    { char: "InUse", get: (s) => (laundryRunning(s, op[0]) ? 1 : 0) },
    {
      // Remaining time as RemainingDuration (seconds). The device reports
      // "HH:MM:SS" (or bare seconds). The cloud plugin raises the ceiling to
      // 14400 s (4 h); HAP's default 3600 is widened in the accessory layer.
      char: "RemainingDuration",
      get: (s) => {
        const rep = s.get(op[0]) ?? {};
        const secs = parseHms(rep["remainingTime"]) ?? parseHms(rep["x.com.samsung.da.remainingTime"]);
        return secs !== undefined ? Math.min(14400, Math.max(0, Math.round(secs))) : undefined;
      },
      props: { maxValue: 14400 },
    },
    {
      // SetDuration (read-only mirror). Apple Home's countdown UI expects the
      // SetDuration/RemainingDuration pair; we can't change the cycle length, so
      // there is no setter (a write just updates the local value with no effect).
      char: "SetDuration",
      get: (s) => {
        const rep = s.get(op[0]) ?? {};
        const secs = parseHms(rep["remainingTime"]) ?? parseHms(rep["x.com.samsung.da.remainingTime"]);
        return secs !== undefined ? Math.min(14400, Math.max(0, Math.round(secs))) : undefined;
      },
      props: { maxValue: 14400 },
    },
  ];
  chars.push({ char: "ValveType", get: () => 0 }); // GENERIC_VALVE (mandatory on Valve)
  // CONFIGURED helps Apple Home render the Valve timer reliably (cloud parity).
  chars.push({ char: "IsConfigured", get: () => 1 });
  return { service: "Valve", subtype: "laundry", name: "Cycle", primary: true, chars, sourceHrefs: [op[0]] };
}

/** Generic companion matchers: temperature sensors, humidity, doors, child lock, power switch. */
function buildGenerics(state: StateMap, mapped: Set<string>, hasPrimary: boolean): ServiceSpec[] {
  const out: ServiceSpec[] = [];

  // Temperature resources (excluding the AC /temperatures items handled above).
  // OCF oic.r.temperature carries a live "temperature"; Samsung fridge zones
  // carry only a setpoint (x.com.samsung.da.definite.desired). HomeKit has a
  // single CurrentTemperature characteristic, so a zone with only a setpoint is
  // shown as that value (read-only) and named "setpoint" to be honest about it.
  for (const [href, r] of findReps(state, (h) => /\/temperature(\/|$)/.test(h))) {
    if (mapped.has(href)) continue;
    const current = num(r["temperature"]);
    const setpoint = num(r["x.com.samsung.da.definite.desired"]) ?? num(r["x.com.samsung.da.desired"]);
    const value = current ?? setpoint;
    if (value === undefined) continue;
    mapped.add(href);
    // Unit: OCF uses "units" ("C"/"F"), vendor uses x.com.samsung.da.unit; HomeKit is °C.
    const fah = isFahrenheit(r["units"] ?? r["x.com.samsung.da.unit"]);
    const conv = (v: number | undefined): number | undefined => (v === undefined ? undefined : fah ? fToC(v) : v);
    const cook = /cook|probe|oven|grill/.test(href); // these read well above 100 °C
    const zone = href.split("/").filter(Boolean).slice(1).filter((p) => p !== "vs" && p !== "0" && p !== "definite").join(" ") || "Temperature";
    const isSetpoint = current === undefined;
    out.push({
      service: "TemperatureSensor", subtype: href, name: isSetpoint ? `${zone} setpoint` : `Temp ${zone}`,
      chars: [{
        char: "CurrentTemperature",
        get: (s) => {
          const rr = s.get(href) ?? {};
          return conv(num(rr["temperature"]) ?? num(rr["x.com.samsung.da.definite.desired"]) ?? num(rr["x.com.samsung.da.desired"]));
        },
        props: { minValue: -50, maxValue: cook ? 600 : 100, minStep: 0.1 },
      }],
      sourceHrefs: [href],
    });
  }

  // Humidity. Samsung reports a raw x.com.samsung.da.humidity (often "0" when
  // unsupported) and a 5%-rounded x.com.samsung.da.fivepercentHumidity; the
  // reference shows the latter. Prefer a non-zero raw, then fivepercent, then
  // the OCF "humidity" field.
  const hum = findRep(state, (h) => h === "/humidity/vs/0") ?? findRep(state, (h) => h.startsWith("/humidity"));
  if (hum) {
    const read = (s: StateMap) => {
      const r = s.get(hum[0]) ?? {};
      const raw = num(r["x.com.samsung.da.humidity"]);
      const five = num(r["x.com.samsung.da.fivepercentHumidity"]);
      const ocf = num(r["humidity"]);
      return (raw && raw > 0 ? raw : undefined) ?? (five && five > 0 ? five : undefined) ?? (ocf && ocf > 0 ? ocf : undefined);
    };
    if (read(state) !== undefined) {
      mapped.add(hum[0]);
      out.push({
        service: "HumiditySensor", subtype: hum[0], name: "Humidity",
        chars: [{ char: "CurrentRelativeHumidity", get: read, props: { minValue: 0, maxValue: 100 } }],
        sourceHrefs: [hum[0]],
      });
    }
  }

  // Doors: prefer OCF oic.r.door (one href per door); fall back to the Samsung
  // /doors/vs/0 aggregate (items[]) only when no OCF door is present.
  const ocfDoors = findReps(state, (h) => /^\/door\//.test(h)).filter(([, r]) => str(r["openState"]) !== undefined);
  for (const [href] of ocfDoors) {
    mapped.add(href);
    const label = href.split("/").filter(Boolean).slice(1).filter((p) => p !== "0").join(" ") || "Door";
    out.push({
      service: "ContactSensor", subtype: href, name: `Door ${label}`,
      chars: [{ char: "ContactSensorState", get: (s) => (str(s.get(href)?.["openState"])?.toLowerCase().startsWith("open") ? 1 : 0) }],
      sourceHrefs: [href],
    });
  }
  if (ocfDoors.length === 0) {
    const agg = findRep(state, (h) => h.startsWith("/doors"));
    const items = agg && Array.isArray(agg[1]["x.com.samsung.da.items"]) ? (agg[1]["x.com.samsung.da.items"] as Rep[]) : [];
    items.forEach((item, idx) => {
      if (str(item["x.com.samsung.da.openState"]) === undefined) return;
      if (agg) mapped.add(agg[0]);
      const id = str(item["x.com.samsung.da.id"]) ?? String(idx);
      const desc = str(item["x.com.samsung.da.description"]) ?? `Door ${id}`;
      out.push({
        service: "ContactSensor", subtype: `${agg![0]}#${id}`, name: desc,
        chars: [{
          char: "ContactSensorState",
          get: (s) => {
            const its = (s.get(agg![0])?.["x.com.samsung.da.items"] as Rep[] | undefined) ?? [];
            const it = its.find((x) => str(x["x.com.samsung.da.id"]) === id) ?? its[idx];
            return str(it?.["x.com.samsung.da.openState"])?.toLowerCase().startsWith("open") ? 1 : 0;
          },
        }],
        sourceHrefs: [agg![0]],
      });
    });
  }

  // Panel/display light: dedicated /light/vs/0 resource (mode On/Off). Matches
  // the reference DISPLAY_LIGHT write (/light/vs/0 {mode}). On/Off only here, so
  // a Lightbulb with just On (no Brightness) — same tile the cloud plugin shows.
  const light = findRep(state, (h) => h === "/light/vs/0");
  if (light && str(light[1]["mode"]) !== undefined) {
    mapped.add(light[0]);
    out.push({
      service: "Lightbulb", subtype: light[0], name: "Display Light",
      chars: [{
        char: "On",
        get: (s) => str(s.get(light[0])?.["mode"]) === "On",
        set: (v) => ({ href: light[0], rep: { mode: v === true || v === 1 ? "On" : "Off" }, requiresRemoteControl: true }),
      }],
      sourceHrefs: [light[0]],
    });
  }

  // Generic power switch when there is no primary service to carry Active
  if (!hasPrimary) {
    const pwr = powerRef(state);
    if (pwr) {
      mapped.add(pwr.href);
      out.push({
        service: "Switch", subtype: pwr.href, name: "Power", primary: true,
        chars: [{
          char: "On",
          get: (s) => readPower(s, pwr) ?? false,
          set: (v) => writePower(pwr, v === true || v === 1),
        }],
        sourceHrefs: [pwr.href],
      });
    }
  }

  return out;
}

function detectArchetype(state: StateMap, deviceTypes: string[]): string {
  // Ported reference routing (gated against the oracle in resolve.test.ts).
  return keyToArchetype(resolveKey(state, deviceTypes));
}

/** Caller options for the engine. */
export interface EngineOptions {
  /** Optional AC "convenient" modes (e.g. Sleep, Speed, WindFree) to expose as
   * switches, like the cloud plugin's airConditionerOptionalMode switches. */
  optionalModes?: string[];
}

/** Build the HomeKit service specs for one appliance from its OCF state. */
export function buildServices(state: StateMap, deviceTypes: string[] = [], opts: EngineOptions = {}): BuildResult {
  const mapped = new Set<string>();
  const archetype = detectArchetype(state, deviceTypes);
  const services: ServiceSpec[] = [];

  let primary: ServiceSpec | undefined;
  if (archetype === "ac") primary = buildAirConditioner(state, mapped);
  else if (archetype === "air_purifier") primary = buildAirPurifier(state, mapped);
  else if (archetype === "laundry") primary = buildLaundry(state, mapped);
  else if (archetype === "dehumidifier") primary = buildDehumidifier(state, mapped);
  if (primary) services.push(primary);
  if (archetype === "fridge") services.push(...buildFridge(state, mapped));
  if (archetype === "laundry") {
    // A ContactSensor that reads "detected" while a cycle runs, for
    // "notify when the wash finishes" automations (cloud parity).
    const op = findRep(state, (h) => h === "/operational/state/vs/0") ?? findRep(state, (h) => h.startsWith("/operational/state"));
    if (op) {
      services.push({
        service: "ContactSensor", subtype: op[0] + "#activity", name: "Running",
        chars: [{ char: "ContactSensorState", get: (s) => (laundryRunning(s, op[0]) ? 1 : 0) }],
        sourceHrefs: [op[0]],
      });
    }
  }

  services.push(...buildGenerics(state, mapped, !!primary || archetype === "fridge"));
  services.push(...buildFilter(state, mapped));
  services.push(...buildAirQuality(state, mapped));

  // AC "convenient"/optional modes (Sleep, Quiet, Speed, WindFree, …) are a
  // single-select on /mode/convenient/vs/0. HomeKit has no select, so — like the
  // cloud plugin — expose the ones the user asked for as Switches (On writes the
  // mode, Off writes "Off"). Reference write: /mode/convenient/vs/0 {modes}.
  const conv = findRep(state, (h) => h === "/mode/convenient/vs/0");
  if (conv && opts.optionalModes && opts.optionalModes.length) {
    const supported = (conv[1]["x.com.samsung.da.supportedModes"] as string[]) ?? [];
    for (const modeName of opts.optionalModes) {
      if (!supported.includes(modeName)) continue;
      mapped.add(conv[0]);
      services.push({
        service: "Switch", subtype: `convenient-${modeName}`, name: modeName,
        chars: [{
          char: "On",
          get: (s) => str(s.get(conv[0])?.["x.com.samsung.da.modes"]) === modeName,
          set: (v) => ({ href: conv[0], rep: { "x.com.samsung.da.modes": v === true || v === 1 ? modeName : "Off" }, requiresRemoteControl: true }),
        }],
        sourceHrefs: [conv[0]],
      });
    }
  }

  // Child lock is deliberately NOT exposed. The reference proved it is
  // read-only on this hardware (writes return 4.05) and its wire value is
  // "Ready"/"Run", not On/Off — so a writable HomeKit lock would be a false
  // control. Left for a future read-only mapping once the semantics are firm.

  return { services, mappedHrefs: mapped, archetype };
}
