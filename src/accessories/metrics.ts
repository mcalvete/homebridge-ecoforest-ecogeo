import type { Characteristic, PlatformAccessory, Service } from 'homebridge';

import type { EcoGeoState } from '../easynet/registers.js';
import type { EcoGeoPlatform } from '../platform.js';
import { EcoGeoAccessory } from './base.js';
import { eveCharacteristics, type EveCharacteristics } from './eve.js';

/** HomeKit light sensors cannot report 0 lx. */
const MIN_LUX = 0.0001;
const MAX_LUX = 100000;

export interface MetricDefinition {
  /** Value to display, or null when unavailable (reported as a HomeKit fault). */
  value: (state: EcoGeoState) => number | null;
  /** Optional Eve characteristic carrying the value in real units. */
  eve?: { characteristic: keyof EveCharacteristics; scale: number };
}

/**
 * Numeric metric (power, COP, pressure) exposed as a light sensor so the Home app shows it:
 * HomeKit has no service for these magnitudes, so the number is displayed with an "lx" unit.
 * Eve additionally shows the real unit through its custom characteristics.
 */
export class MetricAccessory extends EcoGeoAccessory {
  private readonly sensor: Service;
  private readonly eve?: Characteristic;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory, private readonly metric: MetricDefinition) {
    super(platform, accessory);
    const { Service } = platform.api.hap;
    this.sensor = this.named(accessory.getService(Service.LightSensor) ?? accessory.addService(Service.LightSensor, accessory.displayName));

    if (metric.eve) {
      const EveType = eveCharacteristics(platform.api)[metric.eve.characteristic];
      this.eve = this.sensor.characteristics.find((c) => c.UUID === EveType.UUID)
        ?? this.sensor.addCharacteristic(new EveType());
    }
  }

  protected render(state: EcoGeoState): void {
    const { CurrentAmbientLightLevel } = this.platform.api.hap.Characteristic;
    const value = this.metric.value(state);
    if (value === null || !Number.isFinite(value)) {
      this.unavailable();
      return;
    }
    const lux = Math.min(Math.max(value, MIN_LUX), MAX_LUX);
    this.sensor.updateCharacteristic(CurrentAmbientLightLevel, lux);

    if (this.eve && this.metric.eve) {
      this.eve.updateValue(Math.max(value * this.metric.eve.scale, 0));
    }
  }

  override unavailable(): void {
    super.unavailable();
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    this.eve?.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  }
}

/** Generic temperature sensor fed from any temperature in the state. */
export class TemperatureAccessory extends EcoGeoAccessory {
  private readonly sensor: Service;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory, private readonly value: (state: EcoGeoState) => number | null) {
    super(platform, accessory);
    const { Service, Characteristic } = platform.api.hap;
    this.sensor = this.named(accessory.getService(Service.TemperatureSensor) ?? accessory.addService(Service.TemperatureSensor, accessory.displayName));
    this.sensor.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 100 });
  }

  protected render(state: EcoGeoState): void {
    this.setTemp(this.sensor, this.platform.api.hap.Characteristic.CurrentTemperature, this.value(state));
  }
}
