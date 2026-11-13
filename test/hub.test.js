// -----------------------------------------------------------------------------
// Connection lifecycle, device, states, heartbeat, quiet logs, actions.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTION_TEXT } from '../src/hub.js';
import { BASE_CONFIG, ariEvent, createWorld, fakeAsterisk, settle } from './helpers/world.js';

const feature = (key) => `ext:test-integration:server:asterisk:${key}`;

test('connects with the ARI credentials, and never puts them in a log', async () => {
  const { gladys, asterisk, app } = await createWorld();
  const [info] = asterisk.requests;
  assert.equal(info.path, '/asterisk/info');
  assert.equal(
    info.authorization,
    `Basic ${Buffer.from('gladys:not-a-real-secret').toString('base64')}`,
  );
  const url = new URL(asterisk.socket.url);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.pathname, '/ari/events');
  assert.equal(url.searchParams.get('app'), 'gladys');
  assert.equal(url.searchParams.get('api_key'), 'gladys:not-a-real-secret');
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.equal(gladys.fake.lastState(feature('reachable')), 1);
  app.stop();
});

test('publishes one device, never polled by Gladys, named in the chosen language', async () => {
  const { gladys, app } = await createWorld({ config: { ...BASE_CONFIG, language: 'fr' } });
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(device.name, 'Serveur Asterisk');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => f.external_id),
    [feature('reachable'), feature('last_caller'), feature('last_call')],
  );
  app.stop();
});

test('without configuration: a status in four languages, no request', async () => {
  const asterisk = fakeAsterisk();
  const { gladys, app } = await createWorld({ config: { language: 'fr' }, asterisk });
  assert.equal(asterisk.requests.length, 0);
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: CONNECTION_TEXT.notConfigured,
  });
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'the device can be added beforehand');
  app.stop();
});

test('wrong credentials: one status, then retries further and further apart', async () => {
  const asterisk = fakeAsterisk({ status: 401 });
  const { gladys, timers, app } = await createWorld({ asterisk });
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: CONNECTION_TEXT.badCredentials,
  });
  await timers.advance(5_000);
  await timers.advance(10_000);
  await timers.advance(20_000);
  assert.equal(asterisk.calls('GET', '/asterisk/info').length, 4);
  assert.equal(gladys.fake.connectionStatuses.length, 1, 'one status for repeated failures');

  asterisk.status = 200;
  await timers.advance(40_000);
  asterisk.socket.emit('open');
  await settle();
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  app.stop();
});

test('Asterisk down: unreachable, then reconnected once the event stream reopens', async () => {
  const { gladys, asterisk, timers, app } = await createWorld();
  asterisk.status = 'down';
  asterisk.socket.close();
  await settle();
  assert.equal(gladys.fake.lastState(feature('reachable')), 0);
  assert.deepEqual(gladys.fake.connectionStatus.message, CONNECTION_TEXT.unreachable);

  asterisk.status = 200;
  await timers.advance(5_000);
  asterisk.socket.emit('open');
  await settle();
  assert.equal(gladys.fake.lastState(feature('reachable')), 1);
  assert.equal(asterisk.sockets.length, 2);
  app.stop();
});

test('new connection settings reconnect; another language renames the device', async () => {
  const { gladys, asterisk, app } = await createWorld();
  await gladys.fake.configUpdated({ ...BASE_CONFIG, language: 'de' });
  assert.equal(asterisk.sockets.length, 1, 'same server: no reconnection');
  assert.equal(gladys.fake.discoveredDevices[0].name, 'Asterisk-Server');

  await gladys.fake.configUpdated({ ...BASE_CONFIG, ari_url: 'http://192.0.2.20:8088/ari/' });
  await settle();
  assert.equal(asterisk.sockets[0].closed, true);
  assert.equal(new URL(asterisk.socket.url).host, '192.0.2.20:8088');
  app.stop();
});

test('a device added to Gladys gets every value at once, and the widget a refresh', async () => {
  const { gladys, asterisk, app } = await createWorld();
  asterisk.socket.event(ariEvent('IncomingStasisStart'));
  await settle();
  const before = gladys.fake.states.length;
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  const republished = gladys.fake.states.slice(before).map((s) => s.device_feature_external_id);
  assert.deepEqual(republished.sort(), [feature('last_caller'), feature('reachable')]);
  assert.ok(gladys.fake.widgetRefreshes.includes('sip'));
  app.stop();
});

test('unchanged values are republished every 12 hours, not more often', async () => {
  const { gladys, timers, app } = await createWorld();
  const count = () => gladys.fake.states.length;
  const start = count();
  await timers.advance(11 * 3_600_000);
  assert.equal(count(), start);
  await timers.advance(3_600_000);
  assert.equal(count(), start + 1, 'the one value known so far');
  app.stop();
});

test('a normal cycle writes nothing at the info level', async () => {
  const { gladys, asterisk, timers, app } = await createWorld();
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    // Events of other channels, playback noise, heartbeat.
    asterisk.socket.event(ariEvent('PlaybackFinished', { channelId: 'other', playbackId: 'x' }));
    asterisk.socket.event({ type: 'ChannelVarset', channel: { id: 'other' } });
    asterisk.socket.emit('message', { data: 'not json' });
    await timers.advance(13 * 3_600_000);
    await gladys.fake.poll(gladys.fake.discoveredDevices[0]);
  } finally {
    console.log = original;
    process.env.LOG_LEVEL = previous;
  }
  assert.deepEqual(lines, []);
  app.stop();
});

test('the test buttons of the Configuration screen', async () => {
  const { gladys, asterisk, app } = await createWorld();
  const connection = await gladys.fake.action('test_connection');
  assert.equal(connection.data.message.en, 'Connected to Asterisk 23.5.0, ARI events received.');

  const refused = await gladys.fake.action('test_call', {
    number: '0899000000',
    message: 'custom/alarm',
  });
  assert.match(refused.data.message.fr, /^Appel refusé : 0899000000 is not in the allowed/);
  assert.equal(asterisk.calls('POST', '/channels').length, 0);

  const placed = await gladys.fake.action('test_call', { number: '100', message: 'custom/alarm' });
  assert.match(placed.data.message.en, /^Calling 100/);
  assert.equal(asterisk.calls('POST', '/channels').length, 1);

  asterisk.status = 'down';
  asterisk.socket.close();
  await settle();
  const down = await gladys.fake.action('test_connection');
  assert.equal(
    down.data.message.es,
    `Sin conexión con Asterisk: ${CONNECTION_TEXT.unreachable.es}`,
  );
  const notPlaced = await gladys.fake.sceneAction('call', { number: '100', message: 'x' });
  assert.equal(notPlaced.success, false);
  app.stop();
});
