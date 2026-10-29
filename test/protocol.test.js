import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { EasyNetClient } from '../dist/easynet/client.js';
import { parseInt16, parseAnalog, parseBool, toHex16 } from '../dist/easynet/codec.js';

test('codec validates complete int16 values and handles negative temperatures and missing sensors', () => {
  assert.equal(parseInt16('8000'), -32768);
  assert.equal(parseInt16('7fff'), 32767);
  assert.equal(parseAnalog('ffce'), -5);
  assert.equal(parseAnalog('d8f1'), null);
  assert.equal(toHex16(-32768), '8000');
  for (const raw of ['', 'NaN', '10000', '00fg', '-1', '123junk']) {
    assert.throws(() => parseInt16(raw));
  }
  for (const n of [NaN, Infinity, -Infinity, 32768, -32769]) {
    assert.throws(() => toHex16(n));
  }
  assert.equal(parseBool('0'), false);
  assert.equal(parseBool('1'), true);
  for (const raw of ['', '2', 'abc']) assert.throws(() => parseBool(raw));
});

test('response parser rejects missing status, inline errors and unrelated operations', () => {
  assert.deepEqual(EasyNetClient.parseResponse('error_2002=0\r\ndir=6100&num=1&0001\r\n0'), ['0001']);
  assert.deepEqual(EasyNetClient.parseResponse('error_geo_get_reg=0\ndir=6100&num=1&0001\n0', 2002), ['0001']);
  for (const raw of [
    'error_2002=0\ndir=6100&num=1&0001',
    'error_2002=0\ndir=6100&num=1&0001\n-7',
    'error_2002=0\ndir=1&num=1address= 1 error\n0',
    '<html>Login</html>',
    'error_2012=0\ndir=6100&num=1&0001\n0',
  ]) assert.throws(() => EasyNetClient.parseResponse(raw, 2002));
});

async function serverClient(t, handler, timeoutMs = 1000) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler(body, req, res));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return new EasyNetClient({
    host: `http://127.0.0.1:${server.address().port}`, username: 'test', password: 'test', timeoutMs,
  });
}

test('HTTP client uses exact bare-field write format, authentication and serialized requests', async t => {
  const bodies = [];
  let active = 0, maximum = 0;
  const client = await serverClient(t, (body, req, res) => {
    bodies.push(body);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('test:test').toString('base64')}`);
    maximum = Math.max(maximum, ++active);
    setTimeout(() => {
      active--;
      res.end(body.startsWith('idOperacion=2002')
        ? 'error_2002=0\ndir=6100&num=1&0001\n0'
        : body.startsWith('idOperacion=2012') ? 'error_2012=0\n0' : 'error_2011=0\n0');
    }, 5);
  });
  const [values] = await Promise.all([
    client.readRegisters(6100, 1), client.writeRegister(6106, 500), client.writeCoil(1524, true),
  ]);
  assert.equal(values.get(6100), '0001');
  assert.deepEqual(bodies, [
    'idOperacion=2002&dir=6100&num=1', 'idOperacion=2012&dir=6106&num=1&01f4',
    'idOperacion=2011&dir=1524&num=1&1',
  ]);
  assert.equal(maximum, 1);
});

test('HTTP client retries transient -7 and keeps the queue usable', async t => {
  let calls = 0;
  const client = await serverClient(t, (body, req, res) => {
    res.end(++calls === 1 ? 'error_2002=-7\n-7' : 'error_2002=0\ndir=6100&num=1&0001\n0');
  });
  assert.equal((await client.readRegisters(6100, 1)).get(6100), '0001');
  assert.equal(calls, 2);
});

test('HTTP client rejects auth, redirects, corrupt ranges and invalid coil values without retrying', async t => {
  let calls = 0;
  const replies = [
    [401, 'Unauthorized'], [302, 'Redirect'],
    [200, 'error_2002=0\ndir=6101&num=1&0001\n0'],
    [200, 'error_2001=0\ndir=1524&num=1&2\n0'],
    [200, 'error_2002=0\ndir=6100&num=1&00fg\n0'],
    [200, 'error_2002=0\ndir=6100&num=1&0001\n0'],
  ];
  const client = await serverClient(t, (body, req, res) => {
    const [status, response] = replies[calls++];
    res.writeHead(status).end(response);
  });
  await assert.rejects(client.readRegisters(6100, 1), /Authentication/);
  await assert.rejects(client.readRegisters(6100, 1), /HTTP 302/);
  await assert.rejects(client.readRegisters(6100, 1), /different address/);
  await assert.rejects(client.readCoils(1524, 1), /boolean/);
  // Codec errors are not transport failures and must not be retried.
  await assert.rejects(client.readRegisters(6100, 1), /hex/);
  assert.equal((await client.readRegisters(6100, 1)).get(6100), '0001');
  assert.equal(calls, replies.length);
});

test('HTTP client reports truncated streams and times out instead of hanging', async t => {
  const client = await serverClient(t, (body, req, res) => {
    if (body.includes('dir=6100')) {
      res.writeHead(200, { 'Content-Length': 200 });
      res.write('error_2002=0\n');
      setTimeout(() => res.destroy(), 5);
    }
  }, 30);
  await assert.rejects(client.readRegisters(6100, 1));
  await assert.rejects(client.readRegisters(6101, 1), /Timeout/);
});

test('HTTP client validates inputs before sending requests', async t => {
  let calls = 0;
  const client = await serverClient(t, () => { calls++; });
  await assert.rejects(client.readRegisters(NaN, 1));
  await assert.rejects(client.readRegisters(6100, 0));
  await assert.rejects(client.readRegisters(65535, 2));
  assert.throws(() => client.writeRegister(6106, NaN));
  assert.throws(() => client.writeRegister(6106, 1.5));
  assert.throws(() => client.writeCoil(1524, 'garbage'));
  assert.throws(() => client.readBlock(NaN));
  assert.equal(calls, 0);
});

test('HTTP client accepts the legacy alarm response header', async t => {
  const client = await serverClient(t, (body, req, res) => {
    assert.equal(body, 'idOperacion=1079');
    res.end('error_get_alarmas=0\nget_alarmas=N\n0');
  });
  assert.deepEqual(await client.readBlock(1079), ['get_alarmas=N']);
});
