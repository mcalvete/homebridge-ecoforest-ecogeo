/**
 * easyNet transports Modbus values as 4-digit hexadecimal strings holding a
 * signed 16-bit integer. "Analog" registers are scaled by 10.
 */

export const NO_SENSOR_VALUE = -999.9;

export function parseInt16(hex: string): number {
  if (!/^[\da-f]{1,4}$/i.test(hex)) {
    throw new Error(`Invalid easyNet hex value: "${hex}"`);
  }
  const value = Number.parseInt(hex, 16);
  return value >= 0x8000 ? value - 0x10000 : value;
}

export function parseAnalog(hex: string): number | null {
  const value = parseInt16(hex) / 10;
  return value === NO_SENSOR_VALUE ? null : value;
}

export function parseBool(raw: string): boolean {
  if (raw !== '0' && raw !== '1') {
    throw new Error(`Invalid easyNet boolean value: "${raw}"`);
  }
  return raw === '1';
}

export function toHex16(value: number): string {
  const int = Math.round(value);
  if (!Number.isFinite(value) || int < -0x8000 || int > 0x7fff) {
    throw new RangeError(`Value out of int16 range: ${value}`);
  }
  return ((int + 0x10000) % 0x10000).toString(16).padStart(4, '0');
}

export function analogToHex(value: number): string {
  return toHex16(value * 10);
}
