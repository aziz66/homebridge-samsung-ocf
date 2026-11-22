/**
 * Platform-agnostic HomeKit mapping types. The engine produces these from the
 * OCF resource state; the accessory layer turns them into real hap-nodejs
 * services/characteristics. Keeping them plain makes the engine testable with
 * no Homebridge/hap dependency.
 */
export type Rep = Record<string, unknown>;
export type StateMap = Map<string, Rep>;
export type HKValue = number | string | boolean;

/** A write the appliance should receive: CBOR `rep` POSTed to `href`. */
export interface WriteOp {
  href: string;
  rep: Rep;
  /** If true, refuse (or warn) when the appliance reports remote control off. */
  requiresRemoteControl?: boolean;
}

export interface CharSpec {
  /** hap-nodejs Characteristic name, e.g. "CurrentTemperature", "Active". */
  char: string;
  /** Read the current HomeKit value from the resource state (undefined ⇒ no value yet). */
  get?: (state: StateMap) => HKValue | undefined;
  /** Produce the write(s) for a HomeKit set, or null to reject the value. */
  set?: (value: HKValue, state: StateMap) => WriteOp | WriteOp[] | null;
  /** Static characteristic properties (bounds, valid values, step). */
  props?: {
    minValue?: number;
    maxValue?: number;
    minStep?: number;
    validValues?: number[];
    unit?: string;
  };
}

export interface ServiceSpec {
  /** hap-nodejs Service name, e.g. "HeaterCooler", "TemperatureSensor". */
  service: string;
  /** Stable subtype to disambiguate multiple services of the same type. */
  subtype?: string;
  /** Display name for the tile. */
  name: string;
  /** Marks the appliance's main service (one per accessory). */
  primary?: boolean;
  chars: CharSpec[];
  /** Diagnostic: which OCF hrefs this service consumed. */
  sourceHrefs: string[];
}

export interface BuildResult {
  services: ServiceSpec[];
  /** hrefs the engine mapped to at least one characteristic. */
  mappedHrefs: Set<string>;
  /** Appliance archetype chosen (ac, air_purifier, laundry, fridge, generic). */
  archetype: string;
}
