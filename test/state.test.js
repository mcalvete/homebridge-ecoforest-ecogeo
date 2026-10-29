import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Blocks, readState } from '../dist/easynet/registers.js';
import { controllerFixture } from './fixtures.js';

test('state decodes temperatures, power, COP, group demands and energy including daily DHW auxiliary heat', async () => {
  const state = await readState(controllerFixture());
  assert.equal(state.main.outdoor, -5);
  assert.equal(state.tanks.heatingBufferTemp, 27.7);
  assert.equal(state.tanks.coolingBufferTemp, null);
  assert.deepEqual(state.groupSupplySetpoints.slice(0, 2), [27.2, 25.5]);
  assert.deepEqual(state.groupDemands, [1, 2, 0, 0, 0]);
  assert.deepEqual(state.power, { heating: 10000, cooling: 0, electric: 2000 });
  assert.equal(state.cop, 5);
  assert.deepEqual(state.energy, { today: 5.8, month: 78.7 });
  assert.equal(state.alarm, null);
});

test('state applies configured circulation pump power and energy', async () => {
  const client = controllerFixture();
  client.demands[31] = '0001';
  const state = await readState(client);
  assert.equal(state.power.electric, 2100);
  assert.equal(state.cop, 4.8);
  assert.deepEqual(state.energy, { today: 6.4, month: 89.2 });
});

test('state converts all supported instantaneous power units to watts', async () => {
  for (const [unit, expected] of [['000a', 100], ['0014', 10000], ['001e', 100000]]) {
    const client = controllerFixture();
    client.demands[0] = unit;
    client.demands[3] = '0064';
    assert.equal((await readState(client)).power.electric, expected);
  }
});

test('state converts Wh, kWh and MWh energy units correctly', async () => {
  for (const [unit, expected] of [['0000', 0.1], ['000a', 0.1], ['0014', 100], ['001e', 100000]]) {
    const client = controllerFixture();
    client.blocks.set(Blocks.energyToday, [
      `DAU=${unit}`, 'DE=03e8', 'DCI=0000', 'DAAB=000a',
      'DIEH=0000', 'DDBEH=0000', 'DBEH=0000',
    ]);
    assert.equal((await readState(client)).energy.today, expected);
  }
});

test('state distinguishes production, requests, alarms and idle COP', async () => {
  const client = controllerFixture();
  client.main[25] = '0002';
  client.main[26] = '0004';
  client.demands[6] = '0001';
  client.demands[7] = '0001';
  client.demands[3] = '0000';
  client.blocks.set(Blocks.alarms, ['get_alarmas=G040']);
  const state = await readState(client);
  assert.deepEqual(state.production, { heating: true, dhw: true, cooling: false });
  assert.equal(state.demands.heating, true);
  assert.equal(state.demands.dhw, true);
  assert.equal(state.alarm, 'G040');
  assert.equal(state.cop, null);
});

test('heating production recognizes direct and buffer-tank operation modes', async () => {
  for (const mode of ['0001', '0004']) {
    const client = controllerFixture();
    client.main[26] = mode;
    assert.equal((await readState(client)).production.heating, true);
  }
});

test('state rejects truncated or malformed data rather than manufacturing zeros or clearing alarms', async () => {
  const mutations = [
    c => c.main.splice(21),
    c => c.tanks.splice(22),
    c => c.demands.splice(15),
    c => { c.demands[0] = '0028'; },
    c => { c.demands[11] = '0003'; },
    c => c.registers.set(6100, '0009'),
    c => c.registers.set(6101, '0009'),
    c => c.coils.set(1524, 'garbage'),
    c => c.blocks.set(Blocks.alarms, []),
    c => c.blocks.set(Blocks.energyToday, ['DE=0026']),
    c => c.blocks.get(Blocks.energyToday).push('DE=0000'),
    c => c.blocks.get(Blocks.energyToday).splice(1, 1),
  ];
  for (const mutate of mutations) {
    const client = controllerFixture();
    mutate(client);
    await assert.rejects(readState(client));
  }
});
