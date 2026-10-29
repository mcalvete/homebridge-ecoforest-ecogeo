import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hap from '@homebridge/hap-nodejs';
import { EcoGeoPlatform } from '../dist/platform.js';
import { readState } from '../dist/easynet/registers.js';
import { controllerFixture } from './fixtures.js';

class PlatformAccessory extends hap.Accessory {
  context = {};
}

function platformFixture(config = {}) {
  const accessories = [], errors = [], warnings = [], writes = [], events = new Map();
  const api = {
    hap, platformAccessory: PlatformAccessory,
    on(name, callback) { events.set(name, callback); },
    registerPlatformAccessories(plugin, name, added) {
      for (const accessory of added) assert.ok(accessory.services.length > 1);
      accessories.push(...added);
    },
    unregisterPlatformAccessories() {},
  };
  const platform = new EcoGeoPlatform({
    info() {}, warn(m) { warnings.push(m); }, error(m) { errors.push(m); },
  }, {
    platform: 'EcoforestEcoGeo', host: 'http://127.0.0.1', username: 'test', password: 'test', ...config,
  }, api);
  const client = controllerFixture();
  client.writeRegister = async (...args) => { writes.push(['register', ...args]); };
  client.writeCoil = async (...args) => { writes.push(['coil', ...args]); };
  platform.easyNet = client;
  return {
    platform, accessories, errors, warnings, writes, events, client,
    service(kind, type) { return accessories.find(a => a.context.kind === kind).getService(type); },
    dispose() { events.get('shutdown')?.(); },
  };
}

async function initialized(t, config) {
  const f = platformFixture(config);
  f.platform.setupAccessories();
  const state = await readState(f.client);
  for (const handler of f.platform.handlers) handler.update(state);
  f.platform.refreshSoon = () => {};
  t.after(() => f.dispose());
  return f;
}

test('all alarm and demand contacts are closed for active and open for inactive states', async t => {
  const f = await initialized(t, { heatingCoolingGroupCount: 5 });
  const state = await readState(f.client);
  const kinds = ['alarm', 'demand-heating', 'demand-dhw',
    ...Array.from({ length: 5 }, (_, g) => `demand-g${g + 1}`)];
  const { ContactSensorState, StatusFault } = hap.Characteristic;
  for (const active of [false, true, false]) {
    state.alarm = active ? 'G040' : null;
    state.demands.heating = active;
    state.demands.dhw = active;
    state.groupDemands = Array(5).fill(active ? 1 : 0);
    for (const handler of f.platform.handlers) handler.update(state);
    for (const kind of kinds) {
      const sensor = f.service(kind, hap.Service.ContactSensor);
      const contact = sensor.getCharacteristic(ContactSensorState);
      assert.equal(contact.value, active
        ? ContactSensorState.CONTACT_DETECTED : ContactSensorState.CONTACT_NOT_DETECTED, kind);
      assert.equal(contact.statusCode, hap.HAPStatus.SUCCESS, kind);
      assert.ok(!contact.props.perms.includes('pw'), kind);
    }
    assert.equal(f.service('alarm', hap.Service.ContactSensor).getCharacteristic(StatusFault).value,
      active ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
  }
  state.groupDemands = Array(5).fill(2);
  for (const handler of f.platform.handlers) handler.update(state);
  for (const kind of kinds.filter(k => k.startsWith('demand-g'))) {
    assert.equal(f.service(kind, hap.Service.ContactSensor).getCharacteristic(ContactSensorState).value,
      ContactSensorState.CONTACT_DETECTED, kind);
  }
  for (const handler of f.platform.handlers) handler.unavailable();
  for (const kind of kinds) {
    assert.equal(f.service(kind, hap.Service.ContactSensor).getCharacteristic(ContactSensorState).statusCode,
      hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE, kind);
  }
});

test('English accessories keep stable UUIDs and the Combined option retains its subtype', async t => {
  const f = await initialized(t);
  assert.equal(f.accessories.length, 19);
  const names = new Map(f.accessories.map(a => [a.context.kind, a.displayName]));
  assert.equal(names.get('dhw'), 'DHW');
  assert.equal(names.get('heating-supply'), 'Production Supply');
  assert.equal(names.get('energy-today'), 'Consumption Current Day');
  for (const a of f.accessories) {
    assert.equal(a.UUID, hap.uuid.generate(`homebridge-ecoforest-ecogeo:test:${a.context.kind}`));
  }
  const program = f.accessories.find(a => a.context.kind === 'program');
  const combined = program.getServiceById(hap.Service.Switch, 'mixed');
  assert.equal(combined.getCharacteristic(hap.Characteristic.Name).value, 'Combined');
  combined.setCharacteristic(hap.Characteristic.ConfiguredName, 'Custom program');
  const original = program.displayName = 'Custom selector';
  const restored = platformFixture();
  t.after(() => restored.dispose());
  for (const a of f.accessories) restored.platform.configureAccessory(a);
  restored.platform.setupAccessories();
  assert.equal(restored.accessories.length, 0);
  assert.equal(program.displayName, original);
  assert.equal(combined.getCharacteristic(hap.Characteristic.ConfiguredName).value, 'Custom program');
});

test('configuration honors new and legacy counts and rejects invalid values before removing accessories', t => {
  for (const [config, expected] of [
    [{}, 2], [{ heatingCoolingGroupCount: 0 }, 0], [{ groups: 4 }, 4],
    [{ groups: 4, heatingCoolingGroupCount: 1 }, 1], [{ heatingCoolingGroupCount: 5 }, 5],
  ]) {
    const f = platformFixture(config);
    t.after(() => f.dispose());
    f.platform.setupAccessories();
    assert.equal(f.accessories.filter(a => a.context.kind.startsWith('demand-g')).length, expected);
    assert.equal(f.warnings.length, 'groups' in config ? 1 : 0);
  }
  for (const config of [
    { heatingCoolingGroupCount: -1 }, { heatingCoolingGroupCount: 6 },
    { heatingCoolingGroupCount: 1.5 }, { heatingCoolingGroupCount: NaN },
    { pollInterval: 0 }, { pollInterval: Infinity }, { pollInterval: '60' },
    { powerSwitchMode: 'invalid' }, { host: 'https://[' }, { host: 'ftp://example.invalid' },
  ]) {
    const f = platformFixture(config);
    assert.equal(f.events.size, 0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.accessories.length, 0);
  }
});

test('DHW and heating handlers write the intended registers and coils only', async t => {
  const f = await initialized(t);
  const dhw = f.service('dhw', hap.Service.HeaterCooler);
  const heating = f.service('heating', hap.Service.HeaterCooler);
  await dhw.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).handleSetRequest(49);
  await dhw.getCharacteristic(hap.Characteristic.Active).handleSetRequest(0);
  await heating.getCharacteristic(hap.Characteristic.Active).handleSetRequest(0);
  assert.deepEqual(f.writes, [['register', 6106, 490], ['coil', 1524, false], ['coil', 1552, false]]);
  assert.ok(!heating.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).props.perms.includes('pw'));
});

test('power confirmation does not write on the first tap, writes on the second and cancels the revert', async t => {
  const f = await initialized(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const on = f.service('power', hap.Service.Switch).getCharacteristic(hap.Characteristic.On);
  await on.handleSetRequest(false);
  assert.deepEqual(f.writes, []);
  await on.handleSetRequest(false);
  assert.deepEqual(f.writes, [['register', 6100, 0]]);
  t.mock.timers.tick(500);
  assert.equal(on.value, false);
});

test('normal and read-only power modes preserve their intended behavior', async t => {
  const normal = await initialized(t, { powerSwitchMode: 'normal' });
  await normal.service('power', hap.Service.Switch).getCharacteristic(hap.Characteristic.On).handleSetRequest(false);
  assert.deepEqual(normal.writes, [['register', 6100, 0]]);
  const readonly = await initialized(t, { powerSwitchMode: 'readonly' });
  const on = readonly.service('power', hap.Service.Switch).getCharacteristic(hap.Characteristic.On);
  assert.ok(!on.props.perms.includes('pw'));
  assert.deepEqual(readonly.writes, []);
});

test('program off reverts to the latest selection, not the last poll', async t => {
  const f = await initialized(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const accessory = f.accessories.find(a => a.context.kind === 'program');
  const winter = accessory.getServiceById(hap.Service.Switch, 'winter').getCharacteristic(hap.Characteristic.On);
  const summer = accessory.getServiceById(hap.Service.Switch, 'summer').getCharacteristic(hap.Characteristic.On);
  await winter.handleSetRequest(false);
  await summer.handleSetRequest(true);
  t.mock.timers.tick(500);
  assert.equal(winter.value, false);
  assert.equal(summer.value, true);
  assert.deepEqual(f.writes, [['register', 6101, 1]]);
});

test('poll failures and missing sensors report HomeKit faults and recover on valid data', async t => {
  const f = await initialized(t);
  const outdoor = f.service('outdoor', hap.Service.TemperatureSensor).getCharacteristic(hap.Characteristic.CurrentTemperature);
  f.client.readRegisters = async () => { throw new Error('device offline'); };
  await f.platform.poll();
  assert.equal(outdoor.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  f.client.readRegisters = async () => f.client.registers;
  await f.platform.poll();
  assert.equal(outdoor.statusCode, hap.HAPStatus.SUCCESS);
  f.client.main[21] = 'd8f1';
  await f.platform.poll();
  assert.equal(outdoor.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(f.errors.length, 1);
});

test('zero electrical power shows zero COP without a HomeKit communication fault', async t => {
  const f = await initialized(t);
  f.client.demands[3] = '0000';
  const state = await readState(f.client);
  for (const handler of f.platform.handlers) handler.update(state);
  const cop = f.service('cop', hap.Service.LightSensor).getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel);
  assert.equal(state.cop, 0);
  assert.equal(cop.value, 0.0001);
  assert.equal(cop.statusCode, hap.HAPStatus.SUCCESS);
  f.platform.handlers.find(h => h.accessory.context.kind === 'cop').unavailable();
  assert.equal(cop.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  for (const handler of f.platform.handlers) handler.update(state);
  assert.equal(cop.statusCode, hap.HAPStatus.SUCCESS);
  const power = f.service('electric-power', hap.Service.LightSensor).getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel);
  assert.equal(power.value, 0.0001);
  assert.equal(power.statusCode, hap.HAPStatus.SUCCESS);
});

test('shutdown during a poll cannot recreate the polling timer', async t => {
  const f = platformFixture();
  t.after(() => f.dispose());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.client.readRegisters = async () => { await gate; return f.client.registers; };
  const poll = f.platform.poll();
  f.events.get('shutdown')();
  release();
  await poll;
  assert.equal(f.platform.pollTimer, undefined);
  f.platform.refreshSoon();
  assert.equal(f.platform.pollTimer, undefined);
});

test('a fault cancels pending UI reverts instead of clearing the communication error', async t => {
  const f = await initialized(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const on = f.service('power', hap.Service.Switch).getCharacteristic(hap.Characteristic.On);
  await on.handleSetRequest(false);
  for (const handler of f.platform.handlers) handler.unavailable();
  t.mock.timers.tick(500);
  assert.equal(on.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});

test('startup values remain unavailable until the first successful poll', t => {
  const f = platformFixture();
  t.after(() => f.dispose());
  f.platform.setupAccessories();
  const power = f.service('electric-power', hap.Service.LightSensor);
  for (const c of power.characteristics.filter(c => c.displayName !== 'Name')) {
    assert.equal(c.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
});
