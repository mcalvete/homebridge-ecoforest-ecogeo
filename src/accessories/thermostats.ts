import type { PlatformAccessory, Service } from 'homebridge';

import { Coils, OnOff, Registers, type EcoGeoState } from '../easynet/registers.js';
import type { EcoGeoPlatform } from '../platform.js';
import { EcoGeoAccessory } from './base.js';

const DHW_MIN_SETPOINT = 30;
const DHW_MAX_SETPOINT = 65;

/**
 * Domestic hot water tank, exposed as a HeaterCooler: Thermostat showed "No Response"
 * with the 50 C DHW setpoint in the tested Home installation.
 */
export class DhwAccessory extends EcoGeoAccessory {
  private readonly heater: Service;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    const { Service, Characteristic } = platform.api.hap;

    // Drop the Thermostat service cached by earlier versions.
    const legacy = accessory.getService(Service.Thermostat);
    if (legacy) {
      accessory.removeService(legacy);
    }

    this.heater = this.named(accessory.getService(Service.HeaterCooler) ?? accessory.addService(Service.HeaterCooler, accessory.displayName));

    const active = this.writable(this.heater.getCharacteristic(Characteristic.Active));
    this.onSet(active, 'DHW enabled', (value) =>
      platform.client.writeCoil(Coils.dhwEnabled, value === Characteristic.Active.ACTIVE));

    this.heater.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .updateValue(Characteristic.TargetHeaterCoolerState.HEAT)
      .setProps({ validValues: [Characteristic.TargetHeaterCoolerState.HEAT] });

    const threshold = this.setRange(
      this.writable(this.heater.getCharacteristic(Characteristic.HeatingThresholdTemperature)),
      DHW_MIN_SETPOINT, DHW_MAX_SETPOINT, 50,
    );
    this.onSet(threshold, 'DHW setpoint', (value) =>
      platform.client.writeRegister(Registers.dhwSetpoint, Math.round(Number(value) * 10)));

    this.heater.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: 100 });
  }

  protected render(state: EcoGeoState): void {
    const { Characteristic } = this.platform.api.hap;
    const { CurrentHeaterCoolerState: Current } = Characteristic;
    const active = state.onOff !== OnOff.Off && state.dhwEnabled;
    const { dhwTemp, dhwSetpoint } = state.tanks;

    this.heater.updateCharacteristic(Characteristic.Active, state.dhwEnabled ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    this.setTemp(this.heater, Characteristic.CurrentTemperature, dhwTemp);
    this.setTemp(this.heater, Characteristic.HeatingThresholdTemperature, dhwSetpoint);
    this.heater.updateCharacteristic(Current, !active ? Current.INACTIVE : state.production.dhw ? Current.HEATING : Current.IDLE);
  }
}

/**
 * Space heating, represented by the heating buffer tank and exposed as a HeaterCooler
 * (same presentation as DHW).
 * - Active: enables/disables heating only (coil 1552); DHW keeps working.
 * - Mode is fixed to HEAT: the Home app only offers Heat for this service, so the operation
 *   program (Winter/Summer/Auto/Combined) is selected with the "Program" accessory switches.
 * - The buffer setpoint is computed by the heating curve, so it is read-only.
 */
export class HeatingAccessory extends EcoGeoAccessory {
  private readonly heater: Service;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    const { Service, Characteristic } = platform.api.hap;
    const { TargetHeaterCoolerState: Target } = Characteristic;

    // Drop the Thermostat service cached by earlier versions.
    const legacy = accessory.getService(Service.Thermostat);
    if (legacy) {
      accessory.removeService(legacy);
    }

    this.heater = this.named(accessory.getService(Service.HeaterCooler) ?? accessory.addService(Service.HeaterCooler, accessory.displayName));

    const active = this.writable(this.heater.getCharacteristic(Characteristic.Active));
    this.onSet(active, 'heating enabled', async (value) => {
      if (value === Characteristic.Active.ACTIVE) {
        this.warnIfPoweredOff();
      }
      await platform.client.writeCoil(Coils.heatingEnabled, value === Characteristic.Active.ACTIVE);
    });

    this.heater.getCharacteristic(Target)
      .updateValue(Target.HEAT)
      .setProps({ validValues: [Target.HEAT] });

    this.setRange(this.readOnly(this.heater.getCharacteristic(Characteristic.HeatingThresholdTemperature)), 10, 65, 30);
    this.heater.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: 100 });
  }

  private warnIfPoweredOff(): void {
    if (this.state?.onOff === OnOff.Off) {
      this.platform.log.warn(`${this.accessory.displayName}: the heat pump is switched off; turn it on with the power switch.`);
    }
  }

  protected render(state: EcoGeoState): void {
    const { Characteristic } = this.platform.api.hap;
    const { CurrentHeaterCoolerState: Current } = Characteristic;
    const { heatingBufferTemp, heatingBufferSetpoint } = state.tanks;
    const active = state.onOff !== OnOff.Off && state.heatingEnabled;

    this.heater.updateCharacteristic(Characteristic.Active, active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    this.setTemp(this.heater, Characteristic.CurrentTemperature, heatingBufferTemp);
    this.setTemp(this.heater, Characteristic.HeatingThresholdTemperature, heatingBufferSetpoint);

    const current = !active ? Current.INACTIVE
      : state.production.heating ? Current.HEATING
        : Current.IDLE;
    this.heater.updateCharacteristic(Current, current);
  }
}
