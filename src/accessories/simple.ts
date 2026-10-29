import type { PlatformAccessory, Service } from 'homebridge';

import { OnOff, Program, Registers, type EcoGeoState } from '../easynet/registers.js';
import type { EcoGeoPlatform } from '../platform.js';
import { EcoGeoAccessory } from './base.js';

export type PowerSwitchMode = 'normal' | 'confirm' | 'readonly';

/** Window during which a second "off" tap confirms switching the heat pump off. */
const CONFIRM_WINDOW_MS = 10_000;
/** Delay before flipping the switch back on after an unconfirmed "off" tap. */
const REVERT_DELAY_MS = 500;

/**
 * Main power switch of the heat pump (heating, cooling and DHW).
 * HomeKit has no confirmation dialogs, so in "confirm" mode switching off requires
 * two taps within CONFIRM_WINDOW_MS: the first one only arms it and the switch flips back on.
 */
export class PowerSwitchAccessory extends EcoGeoAccessory {
  private readonly switchService: Service;
  private armedUntil = 0;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    const { Service, Characteristic } = platform.api.hap;
    this.switchService = this.named(accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, accessory.displayName));

    const mode: PowerSwitchMode = platform.config.powerSwitchMode ?? 'confirm';
    const on = this.switchService.getCharacteristic(Characteristic.On);

    if (mode === 'readonly') {
      this.readOnly(on);
      return;
    }

    this.writable(on);
    this.onSet(on, 'power', async (value) => {
      if (value || mode === 'normal' || Date.now() < this.armedUntil) {
        this.armedUntil = 0;
        await platform.client.writeRegister(Registers.onOff, value ? OnOff.On : OnOff.Off);
        return;
      }

      this.armedUntil = Date.now() + CONFIRM_WINDOW_MS;
      platform.log.info(`${accessory.displayName}: tap "off" again within ${CONFIRM_WINDOW_MS / 1000} s to switch the heat pump off`);
      this.later(() => {
        if (Date.now() < this.armedUntil) {
          this.switchService.updateCharacteristic(Characteristic.On, true);
        }
      }, REVERT_DELAY_MS);
    });
  }

  protected render(state: EcoGeoState): void {
    this.switchService.updateCharacteristic(this.platform.api.hap.Characteristic.On, state.onOff !== OnOff.Off);
  }
}

/** Contact "closed" (Yes in Eve) while the heat pump reports an active alarm. */
export class AlarmAccessory extends EcoGeoAccessory {
  private readonly sensor: Service;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    const { Service } = platform.api.hap;
    this.sensor = this.named(accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor, accessory.displayName));
  }

  protected render(state: EcoGeoState): void {
    const { ContactSensorState, StatusFault } = this.platform.api.hap.Characteristic;
    const alarm = state.alarm !== null;
    this.sensor.updateCharacteristic(
      ContactSensorState,
      alarm ? ContactSensorState.CONTACT_DETECTED : ContactSensorState.CONTACT_NOT_DETECTED,
    );
    this.sensor.updateCharacteristic(StatusFault, alarm ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
  }
}

/**
 * Contact sensor that is "closed" (Yes in Eve) while a demand is active. Switches were tried first, but the
 * Home app does not show them (Eve does), so a natively read-only sensor is used instead.
 */
export class DemandSensorAccessory extends EcoGeoAccessory {
  private readonly sensor: Service;

  constructor(
    platform: EcoGeoPlatform,
    accessory: PlatformAccessory,
    private readonly isActive: (state: EcoGeoState) => boolean,
  ) {
    super(platform, accessory);
    const { Service } = platform.api.hap;

    // Drop the Switch service cached by earlier versions.
    const legacy = accessory.getService(Service.Switch);
    if (legacy) {
      accessory.removeService(legacy);
    }

    this.sensor = this.named(accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor, accessory.displayName));
  }

  protected render(state: EcoGeoState): void {
    const { ContactSensorState } = this.platform.api.hap.Characteristic;
    this.sensor.updateCharacteristic(
      ContactSensorState,
      this.isActive(state) ? ContactSensorState.CONTACT_DETECTED : ContactSensorState.CONTACT_NOT_DETECTED,
    );
  }
}

const PROGRAMS: { program: Program; subtype: string; name: string }[] = [
  { program: Program.Winter, subtype: 'winter', name: 'Winter' },
  { program: Program.Summer, subtype: 'summer', name: 'Summer' },
  { program: Program.Auto, subtype: 'auto', name: 'Auto' },
  { program: Program.Mixed, subtype: 'mixed', name: 'Combined' },
];

/**
 * Operation program selector: one accessory grouping mutually exclusive switches, so the Home
 * app shows a single tile that expands into the four options (HomeKit has no N-value selector).
 * Turning a switch on writes the program; turning the active one off is ignored.
 */
export class ProgramSelectorAccessory extends EcoGeoAccessory {
  private readonly switches = new Map<Program, Service>();
  private selected?: Program;

  constructor(platform: EcoGeoPlatform, accessory: PlatformAccessory) {
    super(platform, accessory);
    const { Service, Characteristic } = platform.api.hap;

    for (const { program, subtype, name } of PROGRAMS) {
      const service = accessory.getServiceById(Service.Switch, subtype)
        ?? accessory.addService(Service.Switch, name, subtype);
      service.setCharacteristic(Characteristic.Name, name);
      // Only seed the name: the user may rename each option in the Home app.
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addCharacteristic(Characteristic.ConfiguredName).updateValue(name);
      }
      this.switches.set(program, service);

      this.onSet(this.writable(service.getCharacteristic(Characteristic.On)), `program ${name}`, async (value) => {
        if (!value) {
          this.later(() => {
            if (this.selected !== undefined) {
              this.showProgram(this.selected);
            }
          }, REVERT_DELAY_MS);
          return;
        }
        if (this.state?.onOff === OnOff.Off) {
          platform.log.warn(`${accessory.displayName}: the heat pump is switched off; the program applies once it is on.`);
        }
        await platform.client.writeRegister(Registers.program, program);
        // Reflect the exclusive selection immediately; the next refresh confirms it.
        this.showProgram(program);
      });
    }
  }

  private showProgram(selected: Program): void {
    this.selected = selected;
    for (const [program, service] of this.switches) {
      service.updateCharacteristic(this.platform.api.hap.Characteristic.On, program === selected);
    }
  }

  protected render(state: EcoGeoState): void {
    this.showProgram(state.program);
  }
}
