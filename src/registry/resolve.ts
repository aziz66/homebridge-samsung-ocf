/**
 * Device-family routing, ported from the reference registry/by_type/__init__.py
 * (upstream localthings). Returns the registry KEY for a parsed /device/0 state
 * — the same key the reference computes — so this plugin's archetype matches the
 * reference on the captured corpus (gated in test/unit/resolve.test.ts against
 * research/oracle/oracle.json). Order: resource signature → /oic/d type →
 * /information deviceSubType → model board-token/consumer-prefix.
 */
import type { Rep, StateMap } from "./types";

const CONSUMER_PREFIX_TO_KEY: Record<string, string> = {
  WW: "washer", WD: "washer", WF: "washer", WV: "washer", WA: "washer",
  DV: "dryer", DW: "dishwasher",
};
const CONSUMER_DESCRIPTION_TO_KEY: Record<string, string> = {
  TP6X_DRYER_DRUM: "flexdry", TP6X_DRYER_TOPLOAD: "flexdry",
};
const BOARD_TOKEN_TO_KEY: Record<string, string> = {
  REF: "refrigerator",
  RAC: "airconditioner", PRAC: "airconditioner", KRAC: "airconditioner", WAC: "airconditioner",
  FAC: "airconditioner", CAWW: "airconditioner", CAC: "airconditioner", DUCT: "airconditioner",
  RHS: "airconditioner", ARA: "airconditioner",
  DHM: "dehumidifier", EHS: "ehs",
  TVTL: "air_purifier", VTL: "air_purifier", VTWW: "air_purifier", AVT: "air_purifier", AIR: "air_purifier",
  WATERPURIFIER: "water_purifier", ADW: "dishwasher", AMF: "microfiber_filter",
  AHD: "range_hood", RANGE: "range", OVEN: "oven", MICROWAVE: "microwave",
  COOKTOP: "cooktop", CT: "cooktop", VSKR: "vacuum_station", DF: "air_dresser",
  VSWW: "vacuum_station", ASM: "air_monitor",
};
const OIC_TYPE_TO_KEY: Record<string, string> = {
  "oic.d.airconditioner": "airconditioner", "oic.d.airpurifier": "air_purifier",
  "oic.d.cooktop": "cooktop", "oic.d.dishwasher": "dishwasher", "oic.d.dryer": "dryer",
  "oic.d.microwave": "microwave", "oic.d.oven": "oven", "oic.d.range": "range",
  "oic.d.refrigerator": "refrigerator", "oic.d.robotcleaner": "robot_vacuum",
  "oic.d.krefrigerator": "refrigerator", "oic.d.networkaudio": "soundbar", "oic.d.tv": "tv",
  "oic.d.washer": "washer",
  "x.com.st.d.airqualitysensor": "air_monitor", "x.com.st.d.dehumidifier": "dehumidifier",
  "x.com.st.d.hood": "range_hood", "x.com.st.d.microfiberfilter": "microfiber_filter",
  "x.com.st.d.monitor": "monitor", "x.com.st.d.stickcleaner": "vacuum_station",
  "x.com.st.d.steamcloset": "air_dresser", "x.com.st.d.winecellar": "refrigerator",
};
const DEVICE_SUBTYPE_TO_KEY: Record<string, string> = {
  Cooktop: "cooktop", Dryer: "dryer", Refrigerator: "refrigerator",
  Room_Air_Conditioner: "airconditioner", WallOven: "oven", Washer: "washer",
};

const TOKEN_SPLIT = /[^A-Z0-9]+/;
function boardTokens(value: string, cutAt: string): string[] {
  const head = (value || "").split(cutAt)[0].toUpperCase();
  return head.split(TOKEN_SPLIT).filter(Boolean);
}
function boardFamilyKey(value: string, cutAt: string): string | undefined {
  const tokens = boardTokens(value, cutAt);
  if (tokens.includes("REF") && tokens.includes("WATERPURIFIER")) return "water_purifier";
  for (const t of tokens) if (BOARD_TOKEN_TO_KEY[t]) return BOARD_TOKEN_TO_KEY[t];
  return undefined;
}
function consumerModelKey(description: string): string | undefined {
  const head = (description || "").split("/")[0];
  const exact = CONSUMER_DESCRIPTION_TO_KEY[head.toUpperCase()];
  if (exact) return exact;
  const segments = head.split("_");
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.length !== 2 && !/[0-9]/.test(seg)) continue;
    const key = CONSUMER_PREFIX_TO_KEY[seg.slice(0, 2).toUpperCase()];
    if (key) return key;
  }
  return undefined;
}

function forDeviceByResources(resources: StateMap): string | undefined {
  const mode = resources.get("/mode/vs/0") ?? {};
  const options = (mode["x.com.samsung.da.options"] as unknown[]) ?? [];
  const hasDeviceType = options.some((o) => typeof o === "string" && o.startsWith("DeviceType_"));
  const opStates = options.filter((o) => typeof o === "string" && o.startsWith("OperationState")).length;
  if (hasDeviceType && opStates >= 2) return "cooktop";
  if (resources.has("/hood/fanspeed/vs/0") && resources.has("/hood/lamp/vs/0")) return "range_hood";
  let supportedModes = (mode["x.com.samsung.da.supportedModes"] as unknown[]) ?? [];
  if (!Array.isArray(supportedModes)) supportedModes = [];
  const cavity = resources.get("/oven/vs/0");
  if (cavity && typeof cavity === "object") {
    const sm = supportedModes as string[];
    if (sm.some((m) => ["MicroWave", "MicroWaveGrill", "MicroWaveConvection"].includes(m))) return "microwave";
    if (sm.some((m) => typeof m === "string" && m.endsWith("Bake"))) {
      if (resources.has("/cooktopmonitoring/vs/0") || resources.has("/cooktop/status/vs/0")) return "range";
      return "oven";
    }
    if (sm.length === 1 && sm[0] === "NoOperation" && resources.has("/connected/vs/0")) return "oven";
  }
  return undefined;
}
function forDeviceByOicType(deviceTypes: string[]): string | undefined {
  for (const t of deviceTypes) if (OIC_TYPE_TO_KEY[t]) return OIC_TYPE_TO_KEY[t];
  return undefined;
}
function forDeviceBySubtype(subtype: unknown): string | undefined {
  return typeof subtype === "string" ? DEVICE_SUBTYPE_TO_KEY[subtype] : undefined;
}
function forDeviceByModel(modelNum: string, description: string): string | undefined {
  return boardFamilyKey(modelNum, "|") ?? boardFamilyKey(description, "/") ?? consumerModelKey(description);
}

/** The reference registry key for a device, or undefined if unrecognized. */
export function resolveKey(resources: StateMap, deviceTypes: string[] = []): string | undefined {
  const info = (resources.get("/information/vs/0") ?? {}) as Rep;
  return (
    forDeviceByResources(resources) ??
    forDeviceByOicType(deviceTypes) ??
    forDeviceBySubtype(info["x.com.samsung.da.deviceSubType"]) ??
    forDeviceByModel(
      String(info["x.com.samsung.da.modelNum"] ?? ""),
      String(info["x.com.samsung.da.description"] ?? ""),
    )
  );
}

/** Map a reference registry key to the HomeKit mapping archetype. */
export function keyToArchetype(key: string | undefined): string {
  switch (key) {
    case "airconditioner": return "ac";
    case "air_purifier": return "air_purifier";
    case "washer": case "dryer": case "dishwasher": case "flexdry": return "laundry";
    case "refrigerator": return "fridge";
    default: return key ?? "generic";
  }
}
