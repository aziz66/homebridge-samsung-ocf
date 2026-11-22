/**
 * Homebridge dynamic platform: one accessory per configured Samsung appliance.
 *
 * For each appliance it opens a local DTLS/CoAP/OCF session (no Samsung cloud),
 * discovers the resources, maps them to HomeKit via the capability engine, and
 * keeps them live through polling + OBSERVE. The client certificate is minted
 * once and persisted (the authorizing UUID is a constant; the key is ours).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { OcfDevice } from "./ocf/device";
import { discoverSecurePorts } from "./ocf/portdiscovery";
import { buildServices } from "./registry/engine";
import { applyServices, type HapLike, type AccessoryLike, type Logger } from "./homekit/accessory";
import { mintClientCertificate, assertValidUuid, DEFAULT_CLIENT_UUID, type ClientCredential } from "./auth/cert";

export interface ApplianceConfig {
  name: string;
  host: string;
  /** DTLS secure port. If omitted, the plugin discovers it from the appliance's
   * plaintext /oic/res (the port varies per unit and after a power cycle). */
  port?: number;
  /** Override the authorizing certificate UUID if a device needs a different one. */
  uuid?: string;
  /** Allow writes even when the appliance reports remote control off. */
  allowRemoteOffWrites?: boolean;
  /** hrefs to OBSERVE for push updates (optional). */
  observeHrefs?: string[];
  /** AC optional modes to expose as switches, e.g. ["Sleep","Speed","WindFree"]. */
  optionalModes?: string[];
}

interface LtConfig extends PlatformConfig {
  appliances?: ApplianceConfig[];
  pollIntervalMs?: number;
}

export class SamsungOcfPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly devices: OcfDevice[] = [];
  private credential?: ClientCredential;

  constructor(
    private readonly log: Logging,
    private readonly config: LtConfig,
    private readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on("didFinishLaunching", () => {
      void this.start().catch((e) => this.log.error(`startup failed: ${(e as Error).message}`));
    });
    this.api.on("shutdown", () => {
      for (const d of this.devices) void d.close();
    });
  }

  /** Called by Homebridge for each accessory restored from disk. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private get storageDir(): string {
    const dir = join(this.api.user.storagePath(), "samsung-ocf");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async ensureCredential(uuid: string): Promise<ClientCredential> {
    if (this.credential && this.credential.uuid === uuid) return this.credential;
    const file = join(this.storageDir, `client-${uuid}.json`);
    if (existsSync(file)) {
      try {
        this.credential = JSON.parse(readFileSync(file, "utf8")) as ClientCredential;
        return this.credential;
      } catch {
        this.log.warn("stored client credential unreadable; minting a new one");
      }
    }
    this.log.info(`minting client certificate for uuid ${uuid} (local, no cloud)`);
    this.credential = await mintClientCertificate(uuid);
    writeFileSync(file, JSON.stringify(this.credential), { mode: 0o600 });
    return this.credential;
  }

  private async start(): Promise<void> {
    const appliances = this.config.appliances ?? [];
    if (!appliances.length) {
      this.log.warn("no appliances configured; nothing to do");
      return;
    }
    for (const appliance of appliances) {
      try {
        await this.setupAppliance(appliance);
      } catch (e) {
        this.log.error(`${appliance.name}: setup failed: ${(e as Error).message}`);
      }
    }
  }

  private async setupAppliance(cfg: ApplianceConfig): Promise<void> {
    const uuid = cfg.uuid ?? DEFAULT_CLIENT_UUID;
    assertValidUuid(uuid); // never let a config value reach a filename or subject unchecked
    let port = cfg.port;
    if (!port) {
      this.log.info(`[${cfg.name}] no port set; discovering the secure port from ${cfg.host}/oic/res`);
      const candidates = await discoverSecurePorts(cfg.host).catch(() => [] as number[]);
      port = candidates[0];
    }
    if (!port) {
      // Appliance off/unreachable at boot (and no explicit port): retry rather
      // than give up forever.
      this.log.warn(`[${cfg.name}] no secure port yet; retrying discovery in 60s (or set "port" in config)`);
      setTimeout(() => void this.setupAppliance(cfg).catch((e) => this.log.error(`[${cfg.name}] retry failed: ${(e as Error).message}`)), 60_000);
      return;
    }
    const cred = await this.ensureCredential(uuid);
    // Key the accessory on host, not port: the DTLS port can change on a power
    // cycle, and the accessory identity must stay stable so HomeKit keeps the
    // tile, history and automations.
    const accUuid = this.api.hap.uuid.generate(`localthings:${cfg.host}`);

    let accessory = this.accessories.get(accUuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(cfg.name, accUuid);
      this.accessories.set(accUuid, accessory);
    }
    accessory.getService(this.Service.AccessoryInformation)
      ?.setCharacteristic(this.Characteristic.Manufacturer, "Samsung (local)")
      .setCharacteristic(this.Characteristic.Model, "OCF appliance")
      .setCharacteristic(this.Characteristic.SerialNumber, `${cfg.host}:${port}`);

    const device = new OcfDevice({
      host: cfg.host, port, cert: cred.certPem, key: cred.keyPem,
      pollIntervalMs: this.config.pollIntervalMs ?? 30_000,
      observeHrefs: cfg.observeHrefs,
      // Re-discover the port before each reconnect — it can move on a power cycle.
      resolvePort: () => discoverSecurePorts(cfg.host).then((p) => p[0] ?? port).catch(() => port),
      logger: (lvl, msg) => this.log[lvl === "debug" ? "debug" : lvl === "warn" ? "warn" : lvl === "error" ? "error" : "info"](`[${cfg.name}] ${msg}`),
    });
    (device as unknown as { allowRemoteOffWrites?: boolean }).allowRemoteOffWrites = cfg.allowRemoteOffWrites;
    this.devices.push(device);

    const build = () => {
      const result = buildServices(device.state, device.deviceTypes, { optionalModes: cfg.optionalModes });
      const deviceLike = Object.assign(device, { allowRemoteOffWrites: cfg.allowRemoteOffWrites });
      applyServices(this.api.hap as unknown as HapLike, accessory as unknown as AccessoryLike, result.services, deviceLike as never, this.log as unknown as Logger);
      this.log.info(`[${cfg.name}] ${result.archetype}: ${result.services.length} HomeKit services from ${result.mappedHrefs.size} resources`);
    };
    device.once("discovered", build);

    if (isNew) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    device.on("offline", (e) => this.log.warn(`[${cfg.name}] offline: ${e.message}`));
    device.on("online", () => this.log.info(`[${cfg.name}] online`));

    device.start().catch((e) => this.log.warn(`[${cfg.name}] initial connect failed: ${(e as Error).message} (will keep retrying if it was ever reached)`));
  }
}
