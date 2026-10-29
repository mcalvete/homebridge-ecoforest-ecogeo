import type { API, Characteristic, WithUUID } from 'homebridge';

type EveCharacteristic = WithUUID<new () => Characteristic>;

/** Custom characteristics understood by the Eve app (not shown by the Apple Home app). */
export interface EveCharacteristics {
  /** Instantaneous power consumption in watts. */
  Consumption: EveCharacteristic;
  /** Accumulated energy in kWh. */
  TotalConsumption: EveCharacteristic;
  /** Air pressure in hPa (used here for water circuit pressures: 1 bar = 1000 hPa). */
  AirPressure: EveCharacteristic;
}

let cached: EveCharacteristics | undefined;

export function eveCharacteristics(api: API): EveCharacteristics {
  if (cached) {
    return cached;
  }
  const { Characteristic: Base, Formats, Perms } = api.hap;

  class Consumption extends Base {
    static readonly UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Consumption', Consumption.UUID, {
        format: Formats.FLOAT,
        unit: 'W',
        minValue: 0,
        maxValue: 100000,
        minStep: 1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class TotalConsumption extends Base {
    static readonly UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Total Consumption', TotalConsumption.UUID, {
        format: Formats.FLOAT,
        unit: 'kWh',
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.01,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class AirPressure extends Base {
    static readonly UUID = 'E863F10F-079E-48FF-8F27-9C2605A29F52';
    constructor() {
      super('Air Pressure', AirPressure.UUID, {
        format: Formats.FLOAT,
        unit: 'hPa',
        minValue: 0,
        maxValue: 20000,
        minStep: 1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  cached = { Consumption, TotalConsumption, AirPressure };
  return cached;
}
