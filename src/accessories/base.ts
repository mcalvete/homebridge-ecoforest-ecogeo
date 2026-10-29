import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { EcoGeoState } from '../easynet/registers.js';
import type { EcoGeoPlatform } from '../platform.js';

export abstract class EcoGeoAccessory {
  /** Last state received from easyNet, if any. */
  protected state?: EcoGeoState;
  private readonly timers = new Set<NodeJS.Timeout>();
  private disposed = false;

  constructor(
    protected readonly platform: EcoGeoPlatform,
    readonly accessory: PlatformAccessory,
  ) {
    const { Characteristic, Service } = platform.api.hap;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Ecoforest')
      .setCharacteristic(Characteristic.Model, 'ecoGEO (easyNet)')
      .setCharacteristic(Characteristic.SerialNumber, `${platform.serial}-${accessory.context.kind}`);
  }

  update(state: EcoGeoState): void {
    this.state = state;
    this.render(state);
  }

  protected abstract render(state: EcoGeoState): void;

  unavailable(): void {
    this.state = undefined;
    this.clearTimers();
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    const dynamic = [
      Characteristic.On, Characteristic.Active, Characteristic.CurrentTemperature,
      Characteristic.HeatingThresholdTemperature, Characteristic.CurrentHeaterCoolerState,
      Characteristic.ContactSensorState, Characteristic.CurrentAmbientLightLevel,
    ].map((type) => type.UUID);
    for (const service of this.accessory.services) {
      for (const characteristic of service.characteristics) {
        if (dynamic.includes(characteristic.UUID)) {
          characteristic.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  protected later(task: () => void, delayMs: number): void {
    if (this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, delayMs);
    this.timers.add(timer);
  }

  protected named(service: Service): Service {
    return service.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.accessory.displayName);
  }

  /** Exposes a control characteristic without write permission. */
  protected readOnly(characteristic: Characteristic): Characteristic {
    const { Perms } = this.platform.api.hap;
    characteristic.removeOnSet();
    return characteristic.setProps({ perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
  }

  /** Grants write permission (cached accessories keep the permissions of older versions). */
  protected writable(characteristic: Characteristic): Characteristic {
    const { Perms } = this.platform.api.hap;
    return characteristic.setProps({ perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY] });
  }

  /**
   * Registers a write handler. Failures are reported to HomeKit as a communication error,
   * and a refresh is scheduled so the Home app converges to the real device state.
   */
  protected onSet(characteristic: Characteristic, label: string, handler: (value: CharacteristicValue) => Promise<void>): void {
    characteristic.onSet(async (value) => {
      this.platform.log.info(`${this.accessory.displayName}: ${label} -> ${value}`);
      try {
        await handler(value);
      } catch (err) {
        this.platform.log.error(`${this.accessory.displayName}: could not set ${label}: ${err instanceof Error ? err.message : String(err)}`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        this.platform.refreshSoon();
      }
    });
  }

  /**
   * Sets a temperature range. setProps validates the current value, so the max is widened
   * and a valid value seeded before raising the min.
   */
  protected setRange(characteristic: Characteristic, minValue: number, maxValue: number, seed: number): Characteristic {
    return characteristic
      .setProps({ maxValue, minStep: 0.5 })
      .updateValue(seed)
      .setProps({ minValue });
  }

  /** Missing sensors must not look like a valid cached temperature. */
  protected setTemp(service: Service, characteristic: WithUUID<new () => Characteristic>, value: number | null): void {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    service.getCharacteristic(characteristic).updateValue(value === null
      ? new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE) : value);
  }
}
