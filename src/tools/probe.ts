/**
 * Standalone connectivity test, no Homebridge required.
 *
 * Usage:
 *   ECOGEO_HOST='https://YOUR_EASYNET_HOST' ECOGEO_USER='YOUR_SERIAL' ECOGEO_PASS='YOUR_PASSWORD' npm run probe
 *   npm run probe -- registers 6100 2   # raw register dump (easyNet internal addresses)
 *   npm run probe -- coils 1524 1       # raw coil dump
 *   npm run probe -- block 2148         # composite page read
 *   npm run probe -- write-register 6106 500   # raw int16 (analog values x10)
 *   npm run probe -- write-coil 1524 1
 */
import { EasyNetClient, EasyNetError } from '../easynet/client.js';
import { parseInt16 } from '../easynet/codec.js';
import { readState } from '../easynet/registers.js';

const { ECOGEO_HOST, ECOGEO_USER, ECOGEO_PASS, ECOGEO_TRACE } = process.env;
if (!ECOGEO_HOST || !ECOGEO_USER || !ECOGEO_PASS) {
  console.error('Set ECOGEO_HOST, ECOGEO_USER and ECOGEO_PASS environment variables.');
  process.exit(1);
}

const [kind, start, count] = process.argv.slice(2);

try {
  const client = new EasyNetClient({
    host: ECOGEO_HOST,
    username: ECOGEO_USER,
    password: ECOGEO_PASS,
    onTrace: ECOGEO_TRACE === '1' ? (m) => console.error(m) : undefined,
  });
  if (kind === 'write-register') {
    await client.writeRegister(Number(start), Number(count));
    console.log(`OK: register ${start} <- ${count}`);
  } else if (kind === 'write-coil') {
    if (count !== '0' && count !== '1') {
      throw new Error('write-coil requires an address and a value of 0 or 1');
    }
    await client.writeCoil(Number(start), count === '1');
    console.log(`OK: coil ${start} <- ${count}`);
  } else if (kind === 'block') {
    const lines = await client.readBlock(Number(start));
    lines.forEach((raw, i) => {
      const decoded = /^[0-9A-Fa-f]{4}$/.test(raw) ? `int=${parseInt16(raw)}  /10=${parseInt16(raw) / 10}` : '';
      console.log(`${String(i).padStart(3)}  ${raw.padEnd(14)}  ${decoded}`);
    });
  } else if (kind === 'registers' || kind === 'coils') {
    const address = Number(start ?? 1);
    const n = Number(count ?? 10);
    const values = kind === 'registers'
      ? await client.readRegisters(address, n)
      : await client.readCoils(address, n);
    for (const [addr, raw] of values) {
      const decoded = kind === 'registers' ? `int=${parseInt16(raw)}  /10=${parseInt16(raw) / 10}` : raw;
      console.log(`${String(addr).padStart(5)}  ${raw.padEnd(6)}  ${decoded}`);
    }
  } else if (kind === undefined) {
    console.log(JSON.stringify(await readState(client), null, 2));
  } else {
    throw new Error(`Unknown probe command: ${kind}`);
  }
} catch (err) {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  const raw = err instanceof EasyNetError ? err.raw : undefined;
  if (raw !== undefined) {
    console.error('Raw response:', JSON.stringify(raw));
  }
  process.exit(2);
}
