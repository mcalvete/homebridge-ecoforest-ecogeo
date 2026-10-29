import type { EasyNetClient } from './client.js';
import { parseAnalog, parseBool, parseInt16 } from './codec.js';

/**
 * easyNet internal addresses (NOT the BMS Modbus addresses from the Ecoforest Modbus guide).
 * Extracted from the easyNet web UI (firmware 2024).
 */
export const Registers = {
  /** 0=off, 1=on, 2=emergency */
  onOff: 6100,
  /** 0=Winter, 1=Summer, 2=Auto, 3=Combined, 4=Remote */
  program: 6101,
  /** DHW setpoint (analog) */
  dhwSetpoint: 6106,
  /** Heating buffer start delta (analog) */
  heatingBufferDelta: 6148,
} as const;

export const Coils = {
  dhwEnabled: 1524,
  heatingEnabled: 1552,
  coolingEnabled: 1568,
} as const;

export enum OnOff {
  Off = 0,
  On = 1,
  Emergency = 2,
}

export enum Program {
  Winter = 0,
  Summer = 1,
  Auto = 2,
  Mixed = 3,
  Remote = 4,
}

/** Composite read operations used by the easyNet pages. */
export const Blocks = {
  /** Main screen: date/time, circuit temperatures and pressures. */
  main: 2148,
  /** Main screen: production and consumption demands, energy counters. */
  demands: 2149,
  /** Main screen: buffer tanks, DHW and room terminals. */
  tanks: 2151,
  /** Energy counters of the current day ("KEY=hex" lines). */
  energyToday: 2137,
  /** Energy counters of the current month ("KEY=hex" lines). */
  energyMonth: 2140,
  /** Active alarm code ("N" = none). */
  alarms: 1079,
} as const;

const MainIndex = {
  heatingPressure: 18,
  heatingReturn: 19,
  brinePressure: 20,
  outdoor: 21,
  heatingSupply: 22,
  brineSupply: 23,
  brineReturn: 24,
} as const;

/** Production state flags inside the `Blocks.main` (2148) response (integers, not analog). */
const ProductionIndex = {
  dhwMode: 25,
  heatingMode: 26,
  coolingMode: 28,
  dhwHeaterMode: 34,
  dhwActive: 35,
} as const;

/** Indices inside the `Blocks.demands` (2149) response (integers unless noted). */
const DemandsIndex = {
  /** Power units (analog): 1=W, 2=kW with one decimal, 3=MW with three decimals. */
  powerUnits: 0,
  heatingPower: 1,
  coolingPower: 2,
  electricPower: 3,
  activeCooling: 4,
  dhw: 6,
  heating: 7,
  legionella: 8,
  cooling: 9,
  pool: 10,
  /** Consumption demand of groups G1..G5: 0=none, 1=heating, 2=cooling. */
  firstGroup: 11,
  circulationPumpsPower: 30,
  /** 1 = circulation pumps are included in the electric consumption (and COP). */
  includePumpsInCop: 31,
} as const;

/** Multiplier to convert the raw power values to watts, by `powerUnits`. */
const POWER_TO_WATTS: Record<number, number> = { 1: 1, 2: 100, 3: 1000 };

/** Heating group supply setpoints G1..G5 inside the `Blocks.tanks` (2151) response. */
const FIRST_GROUP_SETPOINT_INDEX = 0;

export const MAX_GROUPS = 5;

export enum GroupDemand {
  None = 0,
  Heating = 1,
  Cooling = 2,
}

const TanksIndex = {
  heatingBufferTemp: 20,
  heatingBufferSetpoint: 21,
  heatingBufferDelta: 22,
  coolingBufferTemp: 23,
  coolingBufferSetpoint: 24,
  dhwSetpoint: 26,
  dhwStartDelta: 27,
  dhwTemp: 28,
} as const;

/** Field names of the energy blocks, by period prefix (D = today, M = month). */
function energyKeys(prefix: 'D' | 'M') {
  return {
    units: `${prefix}AU`,
    electric: `${prefix}E`,
    pumps: `${prefix}CI`,
    auxUnits: `${prefix}AAB`,
    auxHeaters: [`${prefix}IEH`, prefix === 'D' ? 'DDBEH' : 'MDEH', `${prefix}BEH`],
  };
}

/** easyNet energy unit codes (value / 10): 0 or 1 = Wh, 2 = kWh, 3 = MWh. */
const ENERGY_TO_KWH: Record<number, number> = { 0: 0.001, 1: 0.001, 2: 1, 3: 1000 };

function parseKeyed(lines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^(\w+)=(.+)$/.exec(line);
    if (!match || fields.has(match[1])) {
      throw new Error(`Invalid or duplicate easyNet field: "${line}"`);
    }
    fields.set(match[1], match[2]);
  }
  return fields;
}

function requiredValue<K extends number | string>(values: Map<K, string>, key: K): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing easyNet field: ${key}`);
  }
  return value;
}

function requiredAnalog(raw: string, label: string): number {
  const value = parseAnalog(raw);
  if (value === null) {
    throw new Error(`Missing easyNet numeric value: ${label}`);
  }
  return value;
}

function unitMultiplier(units: number, factors: Record<number, number>, label: string): number {
  const factor = factors[units];
  if (factor === undefined) {
    throw new Error(`Unsupported easyNet ${label} unit: ${units}`);
  }
  return factor;
}

/**
 * Electric energy consumed in kWh, using the same rules as the easyNet information page:
 * compressor/inverter consumption, plus circulation pumps when configured, plus auxiliary electric heaters.
 */
function electricEnergyKwh(lines: string[], prefix: 'D' | 'M', includePumps: boolean): number {
  const fields = parseKeyed(lines);
  const keys = energyKeys(prefix);
  const value = (key: string) => {
    return requiredAnalog(requiredValue(fields, key), key);
  };

  const electric = value(keys.electric);
  const toKwh = unitMultiplier(value(keys.units), ENERGY_TO_KWH, 'energy');
  const auxToKwh = unitMultiplier(value(keys.auxUnits), ENERGY_TO_KWH, 'auxiliary energy');
  const pumps = includePumps ? value(keys.pumps) : 0;
  const aux = keys.auxHeaters.reduce((sum, key) => sum + value(key), 0);

  return Math.round(((electric + pumps) * toKwh + aux * auxToKwh) * 100) / 100;
}

type Temps<T extends Record<string, number>> = Record<keyof T, number | null>;

export interface EcoGeoState {
  onOff: OnOff;
  program: Program;
  dhwEnabled: boolean;
  heatingEnabled: boolean;
  main: Temps<typeof MainIndex>;
  tanks: Temps<typeof TanksIndex>;
  /** What the heat pump is actually producing right now ("Operation mode"). */
  production: { dhw: boolean; heating: boolean; cooling: boolean };
  /** "Production demands": services requesting production. */
  demands: { dhw: boolean; heating: boolean; cooling: boolean; pool: boolean };
  /** "Consumption demands": demand of groups G1..G5 (index 0 = G1). */
  groupDemands: GroupDemand[];
  /** Heating supply setpoint of groups G1..G5 (index 0 = G1). */
  groupSupplySetpoints: (number | null)[];
  /** Instantaneous power in watts. */
  power: { heating: number; cooling: number; electric: number };
  /** Heating COP (heating / electric), displayed as zero when electric power is zero. */
  cop: number;
  /** Electric energy consumed (kWh) in the current day and month. */
  energy: { today: number | null; month: number | null };
  /** Alarm code reported by easyNet, or null when there is no active alarm. */
  alarm: string | null;
}

function decodeBlock<T extends Record<string, number>>(values: string[], index: T): Temps<T> {
  return Object.fromEntries(
    Object.entries(index).map(([name, i]) => [name, parseAnalog(blockValue(values, i))]),
  ) as Temps<T>;
}

function blockValue(values: string[], index: number): string {
  if (values[index] === undefined) {
    throw new Error(`Incomplete easyNet block: missing index ${index}`);
  }
  return values[index];
}

function enumValue<T extends number>(value: number, allowed: readonly T[], label: string): T {
  const result = allowed.find((candidate) => candidate === value);
  if (result === undefined) {
    throw new Error(`Unsupported easyNet ${label}: ${value}`);
  }
  return result;
}

export async function readState(client: EasyNetClient): Promise<EcoGeoState> {
  const regs = await client.readRegisters(Registers.onOff, 2);
  const dhwCoil = await client.readCoils(Coils.dhwEnabled, 1);
  const heatingCoil = await client.readCoils(Coils.heatingEnabled, 1);
  const main = await client.readBlock(Blocks.main);
  const demands = await client.readBlock(Blocks.demands);
  const tanks = await client.readBlock(Blocks.tanks);
  const energyToday = await client.readBlock(Blocks.energyToday);
  const energyMonth = await client.readBlock(Blocks.energyMonth);
  const alarms = await client.readBlock(Blocks.alarms);

  const int = (values: string[], i: number) => parseInt16(blockValue(values, i));
  const p = Object.fromEntries(Object.entries(ProductionIndex).map(([k, i]) => [k, int(main, i)])) as Record<keyof typeof ProductionIndex, number>;

  const toWatts = unitMultiplier(
    requiredAnalog(blockValue(demands, DemandsIndex.powerUnits), 'powerUnits'), POWER_TO_WATTS, 'power',
  );
  const heatingPower = int(demands, DemandsIndex.heatingPower) * toWatts;
  const coolingPower = int(demands, DemandsIndex.coolingPower) * toWatts;
  const includePumps = int(demands, DemandsIndex.includePumpsInCop) === 1;
  // Same formula as the easyNet main screen.
  const electricPower = (int(demands, DemandsIndex.electricPower)
    + (includePumps ? int(demands, DemandsIndex.circulationPumpsPower) : 0)) * toWatts;

  const alarmCode = requiredValue(parseKeyed(alarms), 'get_alarmas');

  return {
    onOff: enumValue(parseInt16(requiredValue(regs, Registers.onOff)), [OnOff.Off, OnOff.On, OnOff.Emergency], 'on/off'),
    program: enumValue(parseInt16(requiredValue(regs, Registers.program)),
      [Program.Winter, Program.Summer, Program.Auto, Program.Mixed, Program.Remote], 'program'),
    dhwEnabled: parseBool(requiredValue(dhwCoil, Coils.dhwEnabled)),
    heatingEnabled: parseBool(requiredValue(heatingCoil, Coils.heatingEnabled)),
    main: decodeBlock(main, MainIndex),
    tanks: decodeBlock(tanks, TanksIndex),
    // Same conditions the easyNet main screen uses to show the "Operation mode" icons.
    production: {
      dhw: [1, 2, 4].includes(p.dhwMode) || p.dhwHeaterMode === 1 || p.dhwActive === 1,
      heating: p.heatingMode === 1 || p.heatingMode === 4,
      cooling: p.coolingMode === 1,
    },
    demands: {
      dhw: int(demands, DemandsIndex.dhw) !== 0 || int(demands, DemandsIndex.legionella) !== 0,
      heating: int(demands, DemandsIndex.heating) !== 0,
      cooling: int(demands, DemandsIndex.cooling) !== 0 || int(demands, DemandsIndex.activeCooling) !== 0,
      pool: int(demands, DemandsIndex.pool) !== 0,
    },
    groupDemands: Array.from({ length: MAX_GROUPS }, (_, g) => enumValue(
      int(demands, DemandsIndex.firstGroup + g), [GroupDemand.None, GroupDemand.Heating, GroupDemand.Cooling], 'group demand',
    )),
    groupSupplySetpoints: Array.from({ length: MAX_GROUPS }, (_, g) => {
      return parseAnalog(blockValue(tanks, FIRST_GROUP_SETPOINT_INDEX + g));
    }),
    power: { heating: heatingPower, cooling: coolingPower, electric: electricPower },
    cop: electricPower > 0 ? Math.round((heatingPower / electricPower) * 10) / 10 : 0,
    energy: {
      today: electricEnergyKwh(energyToday, 'D', includePumps),
      month: electricEnergyKwh(energyMonth, 'M', includePumps),
    },
    alarm: alarmCode && alarmCode !== 'N' ? alarmCode : null,
  };
}
