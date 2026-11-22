/**
 * Bind capability ServiceSpecs to real hap-nodejs services/characteristics on a
 * Homebridge PlatformAccessory, wiring reads to the device state cache, writes
 * to OCF POSTs (honoring the remote-control guard), and device 'update' events
 * to characteristic pushes.
 */
import type { StateMap, ServiceSpec, HKValue, WriteOp } from "../registry/types";
import { remoteControlOff } from "../registry/engine";

/** The slice of OcfDevice the accessory layer needs (keeps it unit-testable). */
export interface DeviceLike {
  readonly state: StateMap;
  write(href: string, rep: Record<string, unknown>): Promise<boolean>;
  on(event: "update", cb: (href: string, rep: Record<string, unknown>) => void): unknown;
  allowRemoteOffWrites?: boolean;
}

// Minimal structural types to avoid a hard homebridge type import here.
interface HapCharacteristic {
  updateValue(v: unknown): HapCharacteristic;
  setProps(p: Record<string, unknown>): HapCharacteristic;
  onGet(h: () => unknown): HapCharacteristic;
  onSet(h: (v: unknown) => void | Promise<void>): HapCharacteristic;
  value: unknown;
}
interface HapService {
  getCharacteristic(c: unknown): HapCharacteristic;
  setCharacteristic(c: unknown, v: unknown): HapService;
  subtype?: string;
}
export interface HapLike {
  Service: Record<string, new (displayName?: string, subtype?: string) => HapService>;
  Characteristic: Record<string, (new () => unknown) & { readonly UUID?: string }>;
}
export interface AccessoryLike {
  displayName: string;
  getService(name: string): HapService | undefined;
  getServiceById(type: unknown, subtype: string): HapService | undefined;
  addService(svc: HapService): HapService;
  removeService(svc: HapService): void;
  services: HapService[];
}
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function clampToProps(v: HKValue | undefined, props?: { minValue?: number; maxValue?: number; validValues?: number[] }): HKValue | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number" && props) {
    if (props.validValues && !props.validValues.includes(v)) return props.validValues[0];
    let n = v;
    if (props.minValue !== undefined) n = Math.max(n, props.minValue);
    if (props.maxValue !== undefined) n = Math.min(n, props.maxValue);
    return n;
  }
  return v;
}

const DEFAULTS: Record<string, number | boolean> = {
  CurrentTemperature: 0, CurrentRelativeHumidity: 0, Active: 0, On: false,
  ContactSensorState: 0, CurrentHeaterCoolerState: 0, TargetHeaterCoolerState: 0,
  CoolingThresholdTemperature: 10, HeatingThresholdTemperature: 25, InUse: 0,
  ValveType: 0, RemainingDuration: 0, CurrentAirPurifierState: 0,
  TargetAirPurifierState: 1, LockPhysicalControls: 0,
};

/** Create/refresh the HAP services for one accessory from its ServiceSpecs. */
export function applyServices(
  hap: HapLike,
  accessory: AccessoryLike,
  specs: ServiceSpec[],
  device: DeviceLike,
  log: Logger,
): void {
  const ctorByChar = new Map<string, unknown>();
  const charName = new Map<unknown, string>();
  const charCtor = (name: string): unknown => {
    let c = ctorByChar.get(name);
    if (!c) {
      c = hap.Characteristic[name];
      if (!c) throw new Error(`unknown HAP characteristic: ${name}`);
      ctorByChar.set(name, c);
      charName.set(c, name);
    }
    return c;
  };

  for (const spec of specs) {
    const ServiceCtor = hap.Service[spec.service];
    if (!ServiceCtor) {
      log.warn(`skipping unknown HAP service ${spec.service}`);
      continue;
    }
    const subtype = spec.subtype ?? spec.service;
    let service = accessory.getServiceById(ServiceCtor, subtype);
    if (!service) {
      service = accessory.addService(new ServiceCtor(spec.name, subtype));
    }

    for (const c of spec.chars) {
      const ctor = charCtor(c.char);
      const ch = service.getCharacteristic(ctor);
      // Seed a valid, in-range value BEFORE setProps: setProps re-validates the
      // characteristic's current value against the new bounds, and hap's own
      // default (e.g. 10 for a threshold temp) can violate a min we set.
      let initial: HKValue | undefined;
      try {
        initial = c.get ? c.get(device.state) : undefined;
      } catch {
        initial = undefined;
      }
      const seed = clampToProps(initial ?? DEFAULTS[c.char], c.props);
      // Seed without any HAP setup-time range warning. For a numeric-range
      // characteristic, first widen its range (format-aware: uint cannot go
      // below 0) so the seed is always in range, then seed, then set the real
      // props (by which point the current value is already in range). A
      // validValues characteristic keeps its default valid set until after the
      // seed, so seed-then-setProps is correct for it.
      const fmt = (ch as unknown as { props?: { format?: string } }).props?.format;
      const isUint = typeof fmt === "string" && fmt.startsWith("uint");
      const rangeProps = !!c.props && !c.props.validValues &&
        (c.props.minValue !== undefined || c.props.maxValue !== undefined);
      if (rangeProps) ch.setProps({ minValue: isUint ? 0 : -270, maxValue: 1_000_000 });
      if (seed !== undefined) ch.updateValue(seed);
      if (c.props) ch.setProps(c.props as Record<string, unknown>);
      ch.onGet(() => {
        try {
          const v = c.get ? c.get(device.state) : undefined;
          return clampToProps(v ?? DEFAULTS[c.char], c.props) ?? DEFAULTS[c.char] ?? 0;
        } catch (e) {
          log.debug(`get ${spec.name}.${c.char} failed: ${(e as Error).message}`);
          return DEFAULTS[c.char] ?? 0;
        }
      });
      if (c.set) {
        ch.onSet(async (value) => {
          const op = c.set!(value as HKValue, device.state);
          if (!op) {
            log.warn(`${spec.name}.${c.char}: value ${String(value)} rejected`);
            return;
          }
          const ops: WriteOp[] = Array.isArray(op) ? op : [op];
          for (const w of ops) {
            if (w.requiresRemoteControl && remoteControlOff(device.state) && !device.allowRemoteOffWrites) {
              log.warn(`${spec.name}.${c.char}: appliance reports remote control off; write to ${w.href} refused (enable "allow writes when remote control is off" to override)`);
              throw new Error("remote control is off");
            }
            const ok = await device.write(w.href, w.rep);
            if (!ok) log.warn(`write to ${w.href} was not accepted`);
          }
        });
      }
    }
  }

  // push updates: on any resource change, re-evaluate every characteristic get
  device.on("update", () => {
    for (const spec of specs) {
      const ServiceCtor = hap.Service[spec.service];
      const service = accessory.getServiceById(ServiceCtor, spec.subtype ?? spec.service);
      if (!service) continue;
      for (const c of spec.chars) {
        try {
          const v = c.get ? c.get(device.state) : undefined;
          const clamped = clampToProps(v, c.props);
          if (clamped !== undefined) service.getCharacteristic(charCtor(c.char)).updateValue(clamped);
        } catch {
          /* ignore */
        }
      }
    }
  });
}
