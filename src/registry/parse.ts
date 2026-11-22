/**
 * Value parsing for Samsung OCF reps. Fields arrive as strings ("17.0", "On")
 * or numbers; HomeKit wants numbers/enums. These helpers normalize them.
 */
import type { Rep, StateMap } from "./types";

export function rep(state: StateMap, href: string): Rep | undefined {
  return state.get(href);
}

/** First rep whose href matches a predicate (e.g. a /vs/0 sibling of a base). */
export function findRep(state: StateMap, pred: (href: string) => boolean): [string, Rep] | undefined {
  for (const [href, r] of state) if (pred(href)) return [href, r];
  return undefined;
}

/** All reps whose href matches a predicate. */
export function findReps(state: StateMap, pred: (href: string) => boolean): Array<[string, Rep]> {
  const out: Array<[string, Rep]> = [];
  for (const [href, r] of state) if (pred(href)) out.push([href, r]);
  return out;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Samsung on/off fields are the strings "On"/"Off". */
export function onOff(v: unknown): boolean | undefined {
  if (v === "On" || v === "on" || v === true) return true;
  if (v === "Off" || v === "off" || v === false) return false;
  return undefined;
}
export const toOnOff = (b: boolean): string => (b ? "On" : "Off");
