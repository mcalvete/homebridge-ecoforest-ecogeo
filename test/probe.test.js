import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('probe rejects invalid coil values and unknown commands without accessing a controller', () => {
  for (const [args, expected] of [
    [['write-coil', '1524', 'false'], /requires an address and a value of 0 or 1/],
    [['unknown'], /Unknown probe command/],
    [['write-register', '6106', 'NaN'], /register value/],
  ]) {
    const result = spawnSync(process.execPath, ['dist/tools/probe.js', ...args], {
      env: { ...process.env, ECOGEO_HOST: 'http://127.0.0.1:1', ECOGEO_USER: 'test', ECOGEO_PASS: 'test' },
      encoding: 'utf8', timeout: 2000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
  }
});
