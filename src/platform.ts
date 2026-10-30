import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import type { EcoGeoAccessory } from './accessories/base.js';
import {
  AlarmAccessory,
  DemandSensorAccessory,
  PowerSwitchAccessory,
  ProgramSelectorAccessory,
  type PowerSwitchMode,
} from './accessories/simple.js';
import { MetricAccessory, TemperatureAccessory, type MetricDefinition } from './accessories/metrics.js';
import { DhwAccessory, HeatingAccessory } from './accessories/thermostats.js';
import { EasyNetClient } from './easynet/client.js';
import { GroupDemand, MAX_GROUPS, readState, type EcoGeoState } from './easynet/registers.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { translations, type AccessoryNames, type Language } from './translations.js';

export interface EcoGeoConfig extends PlatformConfig {
  host?: string;
  username?: string;
  password?: string;
  pollInterval?: number;
  powerSwitchMode?: PowerSwitchMode;
  language?: Language;
  /** Number of consumption groups installed (G1..Gn). */
  heatingCoolingGroupCount?: number;
  /** @deprecated Use heatingCoolingGroupCount instead. */
  groups?: number;
  debug?: boolean;
}

type AccessoryFactory = (platform: EcoGeoPlatform, accessory: PlatformAccessory) => EcoGeoAccessory;

interface AccessoryDefinition {
  kind: string;
  name: string;
  create: AccessoryFactory;
}

const DEFAULT_GROUPS = 2;

function accessoryDefinitions(groups: number, names: AccessoryNames): AccessoryDefinition[] {
  const demand = (isActive: (s: EcoGeoState) => boolean): AccessoryFactory =>
    (platform, accessory) => new DemandSensorAccessory(platform, accessory, isActive);
  const temperature = (value: (s: EcoGeoState) => number | null): AccessoryFactory =>
    (platform, accessory) => new TemperatureAccessory(platform, accessory, value);
  const metric = (definition: MetricDefinition): AccessoryFactory =>
    (platform, accessory) => new MetricAccessory(platform, accessory, definition);
  const perGroup = (build: (g: number) => AccessoryDefinition): AccessoryDefinition[] =>
    Array.from({ length: groups }, (_, g) => build(g));

  return [
    { kind: 'dhw', name: names.dhw, create: (p, a) => new DhwAccessory(p, a) },
    { kind: 'heating', name: names.heating, create: (p, a) => new HeatingAccessory(p, a) },
    { kind: 'outdoor', name: names.outdoor, create: temperature((s) => s.main.outdoor) },
    { kind: 'heating-supply', name: names.productionSupply, create: temperature((s) => s.main.heatingSupply) },
    ...perGroup((g) => ({
      kind: `supply-setpoint-g${g + 1}`,
      name: `G${g + 1} ${names.groupSetpoint}`,
      create: temperature((s) => s.groupSupplySetpoints[g]),
    })),
    {
      kind: 'electric-power',
      name: names.electricPower,
      create: metric({ value: (s) => s.power.electric, eve: { characteristic: 'Consumption', scale: 1 } }),
    },
    {
      kind: 'energy-today',
      name: names.consumptionDay,
      create: metric({ value: (s) => s.energy.today, eve: { characteristic: 'TotalConsumption', scale: 1 } }),
    },
    {
      kind: 'energy-month',
      name: names.consumptionMonth,
      create: metric({ value: (s) => s.energy.month, eve: { characteristic: 'TotalConsumption', scale: 1 } }),
    },
    { kind: 'cop', name: names.cop, create: metric({ value: (s) => s.cop }) },
    {
      kind: 'heating-pressure',
      name: names.productionPressure,
      create: metric({ value: (s) => s.main.heatingPressure, eve: { characteristic: 'AirPressure', scale: 1000 } }),
    },
    {
      kind: 'brine-pressure',
      name: names.brinePressure,
      create: metric({ value: (s) => s.main.brinePressure, eve: { characteristic: 'AirPressure', scale: 1000 } }),
    },
    { kind: 'power', name: names.heatPump, create: (p, a) => new PowerSwitchAccessory(p, a) },
    { kind: 'program', name: names.program, create: (p, a) => new ProgramSelectorAccessory(p, a) },
    { kind: 'alarm', name: names.alarm, create: (p, a) => new AlarmAccessory(p, a) },
    { kind: 'demand-heating', name: names.heatingDemand, create: demand((s) => s.demands.heating) },
    { kind: 'demand-dhw', name: names.dhwDemand, create: demand((s) => s.demands.dhw) },
    ...perGroup((g) => ({
      kind: `demand-g${g + 1}`,
      name: `G${g + 1} ${names.groupDemand}`,
      create: demand((s) => s.groupDemands[g] !== GroupDemand.None),
    })),
  ];
}

const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;
/** Delay before re-reading the device after a write, so changes are reflected quickly. */
const REFRESH_AFTER_WRITE_MS = 3000;

export class EcoGeoPlatform implements DynamicPlatformPlugin {
  readonly serial: string;
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly handlers: EcoGeoAccessory[] = [];
  private easyNet?: EasyNetClient;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private refreshPending = false;
  private lastPollFailed = false;
  private stopped = false;

  constructor(
    readonly log: Logging,
    readonly config: EcoGeoConfig,
    readonly api: API,
  ) {
    const { host, username, password } = config;
    this.serial = username ?? 'unknown';

    if (typeof host !== 'string' || typeof username !== 'string' || typeof password !== 'string'
      || !host.trim() || !username.trim() || !password) {
      this.log.error('Missing "host", "username" or "password" in config. Plugin disabled.');
      return;
    }

    try {
      for (const [label, value, min, max] of [
        ['heatingCoolingGroupCount', config.heatingCoolingGroupCount ?? config.groups ?? DEFAULT_GROUPS, 0, MAX_GROUPS],
        ['pollInterval', config.pollInterval ?? DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, 3600],
      ] as const) {
        if (!Number.isInteger(value) || value < min || value > max) {
          throw new Error(`"${label}" must be an integer between ${min} and ${max}`);
        }
      }
      if (config.powerSwitchMode !== undefined && !['normal', 'confirm', 'readonly'].includes(config.powerSwitchMode)) {
        throw new Error('"powerSwitchMode" must be normal, confirm or readonly');
      }
      if (config.language !== undefined
        && (typeof config.language !== 'string' || !Object.hasOwn(translations, config.language))) {
        throw new Error(`"language" must be one of: ${Object.keys(translations).join(', ')}`);
      }
      this.easyNet = new EasyNetClient({
        host,
        username,
        password,
        onTrace: config.debug ? (m) => this.log.info(`[easyNet] ${m}`) : undefined,
      });
    } catch (error) {
      this.log.error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}. Plugin disabled.`);
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.setupAccessories();
      void this.poll();
    });
    this.api.on('shutdown', () => {
      this.stopped = true;
      clearTimeout(this.pollTimer);
      for (const handler of this.handlers) {
        handler.dispose();
      }
    });
  }

  get names(): AccessoryNames {
    return translations[this.config.language ?? 'en'];
  }

  /** Only available with a valid config; accessories are created only in that case. */
  get client(): EasyNetClient {
    if (!this.easyNet) {
      throw new Error('easyNet client not configured');
    }
    return this.easyNet;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private setupAccessories(): void {
    const activeUuids = new Set<string>();

    if (this.config.groups !== undefined) {
      this.log.warn('Configuration "groups" is deprecated; use "heatingCoolingGroupCount" instead.');
    }
    const groups = this.config.heatingCoolingGroupCount ?? this.config.groups ?? DEFAULT_GROUPS;

    for (const { kind, name, create } of accessoryDefinitions(groups, this.names)) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.serial}:${kind}`);
      activeUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory(name, uuid);
      }
      accessory.context.kind = kind;
      const handler = create(this, accessory);
      handler.unavailable();
      this.handlers.push(handler);
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added accessory "${name}"`);
      }
    }

    const stale = [...this.cachedAccessories.values()].filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} stale accessories`);
    }
  }

  /** Schedules an early poll (e.g. after a write). Never runs concurrently with an ongoing poll. */
  refreshSoon(): void {
    if (this.stopped) {
      return;
    }
    if (this.polling) {
      this.refreshPending = true;
      return;
    }
    this.schedulePoll(REFRESH_AFTER_WRITE_MS);
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const state = await readState(this.client);
      if (this.stopped) {
        return;
      }
      if (this.config.debug) {
        this.log.info(`State: ${JSON.stringify(state)}`);
      }
      for (const handler of this.handlers) {
        handler.update(state);
      }
      if (this.lastPollFailed) {
        this.log.info('easyNet connection restored');
      }
      this.lastPollFailed = false;
    } catch (err) {
      // Log once per outage to avoid flooding the log.
      if (!this.lastPollFailed) {
        this.log.error(`Could not read from easyNet: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.lastPollFailed = true;
      for (const handler of this.handlers) {
        handler.unavailable();
      }
    } finally {
      this.polling = false;
    }

    if (this.refreshPending) {
      this.refreshPending = false;
      this.schedulePoll(REFRESH_AFTER_WRITE_MS);
    } else {
      const seconds = this.config.pollInterval ?? DEFAULT_POLL_SECONDS;
      this.schedulePoll(seconds * 1000);
    }
  }
}
