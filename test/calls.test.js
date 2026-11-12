// -----------------------------------------------------------------------------
// Outgoing and incoming calls, end to end: scene action → ARI requests →
// replayed Asterisk events → states and scene events received by Gladys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unansweredResult } from '../src/calls.js';
import { BASE_CONFIG, ariEvent, createWorld, fakeAsterisk, settle } from './helpers/world.js';

const ALARM = { number: '+33600000001', message: 'custom/alarm' };

/** The channel id of the last originate. */
const lastChannel = (asterisk) => asterisk.calls('POST', '/channels').at(-1).query.channelId;

async function answer(asterisk, channelId) {
  asterisk.socket.event(ariEvent('StasisStart', { channelId, args: ['gladys-outgoing'] }));
  await settle();
}

async function playbackDone(asterisk, channelId) {
  const playbackId = asterisk
    .calls('POST', `/channels/${channelId}/play/`)
    .at(-1)
    .path.split('/')
    .pop();
  asterisk.socket.event(ariEvent('PlaybackFinished', { channelId, playbackId }));
  await settle();
}

async function destroyed(asterisk, channelId, cause = 16) {
  asterisk.socket.event(ariEvent('ChannelDestroyed', { channelId, cause }));
  await settle();
}

const lastText = (gladys, key) =>
  gladys.fake.lastState(`ext:test-integration:server:asterisk:${key}`);

test('an acknowledged alarm call: answered, message played, 1 pressed', async () => {
  const { gladys, asterisk, app } = await createWorld();
  const ack = await gladys.fake.sceneAction('call', { ...ALARM, require_ack: true, repeat: 3 });
  assert.equal(ack.success, true);
  assert.equal(ack.data.outputs.started, true);

  const [originate] = asterisk.calls('POST', '/channels');
  assert.equal(originate.query.endpoint, 'PJSIP/+33600000001@trunk');
  assert.equal(originate.query.app, 'gladys');
  assert.equal(originate.query.timeout, '30');
  const channelId = lastChannel(asterisk);

  await answer(asterisk, channelId);
  const [play] = asterisk.calls('POST', `/channels/${channelId}/play/`);
  assert.equal(play.query.media, 'sound:custom/alarm');

  asterisk.socket.event(ariEvent('ChannelDtmfReceived', { channelId, digit: '1' }));
  await settle();
  assert.equal(asterisk.calls('DELETE', '/playbacks/').length, 1);
  assert.equal(asterisk.calls('DELETE', `/channels/${channelId}`).length, 1);
  await destroyed(asterisk, channelId);

  assert.deepEqual(gladys.fake.sceneEvents, [
    { key: 'call_finished', data: { number: '+33600000001', result: 'acknowledged', attempts: 1 } },
  ]);
  assert.equal(lastText(gladys, 'last_call'), '+33600000001: acknowledged');
  assert.equal(asterisk.calls('POST', '/channels').length, 1, 'no further attempt');
  app.stop();
});

test('the message is repeated, then the call waits for the 1 and tries again', async () => {
  const { gladys, asterisk, timers, app } = await createWorld();
  await gladys.fake.sceneAction('call', {
    ...ALARM,
    require_ack: true,
    repeat: 2,
    attempts: 2,
    retry_delay: 60,
  });
  const first = lastChannel(asterisk);
  await answer(asterisk, first);
  await playbackDone(asterisk, first);
  await timers.advance(1_000); // pause between plays
  assert.equal(asterisk.calls('POST', `/channels/${first}/play/`).length, 2);
  await playbackDone(asterisk, first);
  // A digit other than 1 does not acknowledge.
  asterisk.socket.event(ariEvent('ChannelDtmfReceived', { channelId: first, digit: '5' }));
  await timers.advance(10_000);
  assert.equal(asterisk.calls('DELETE', `/channels/${first}`).length, 1);
  await destroyed(asterisk, first);
  assert.deepEqual(gladys.fake.sceneEvents, [], 'answered without 1: not over yet');

  await timers.advance(59_000);
  assert.equal(asterisk.calls('POST', '/channels').length, 1);
  await timers.advance(1_000);
  const second = lastChannel(asterisk);
  assert.notEqual(second, first);
  await destroyed(asterisk, second, 19);

  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data, {
    number: '+33600000001',
    result: 'no_answer',
    attempts: 2,
  });
  assert.equal(lastText(gladys, 'last_call'), '+33600000001: no answer (2×)');
  app.stop();
});

test('without acknowledgement, being answered ends the call after the message', async () => {
  const { gladys, asterisk, app } = await createWorld();
  await gladys.fake.sceneAction('call', { ...ALARM, repeat: 1, message: 'custom/leak, digits:12' });
  const channelId = lastChannel(asterisk);
  await answer(asterisk, channelId);
  assert.equal(
    asterisk.calls('POST', `/channels/${channelId}/play/`)[0].query.media,
    'sound:custom/leak,digits:12',
  );
  // DTMF is ignored when no acknowledgement is asked.
  asterisk.socket.event(ariEvent('ChannelDtmfReceived', { channelId, digit: '1' }));
  await playbackDone(asterisk, channelId);
  assert.equal(asterisk.calls('DELETE', `/channels/${channelId}`).length, 1);
  await destroyed(asterisk, channelId);
  assert.equal(gladys.fake.sceneEvents.at(-1).data.result, 'answered');
  app.stop();
});

test('a refused originate counts as a failed attempt', async () => {
  const asterisk = fakeAsterisk();
  const { gladys, timers, app } = await createWorld({ asterisk });
  asterisk.failNext = (request) => (request.path === '/channels' ? 400 : null);
  await gladys.fake.sceneAction('call', { ...ALARM, attempts: 2, retry_delay: 0 });
  await settle();
  await timers.advance(0);
  await settle();
  assert.equal(asterisk.calls('POST', '/channels').length, 2);
  assert.deepEqual(gladys.fake.sceneEvents.at(-1).data, {
    number: '+33600000001',
    result: 'failed',
    attempts: 2,
  });
  app.stop();
});

test('a second call to the same number while one runs is not placed', async () => {
  const { gladys, asterisk, app } = await createWorld();
  const first = await gladys.fake.sceneAction('call', ALARM);
  const second = await gladys.fake.sceneAction('call', ALARM);
  assert.equal(second.data.outputs.started, false);
  assert.equal(second.data.outputs.call_id, first.data.outputs.call_id);
  assert.equal(asterisk.calls('POST', '/channels').length, 1);
  app.stop();
});

test('cancel_calls stops a ringing call and the pending retries', async () => {
  const { gladys, asterisk, timers, app } = await createWorld();
  await gladys.fake.sceneAction('call', { ...ALARM, attempts: 3 });
  await gladys.fake.sceneAction('call', { number: '100', message: 'custom/alarm', attempts: 3 });
  const toMobile = asterisk.calls('POST', '/channels')[0].query.channelId;
  const toDesk = lastChannel(asterisk);
  await destroyed(asterisk, toDesk, 17); // busy: a retry is scheduled

  const ack = await gladys.fake.sceneAction('cancel_calls', {});
  assert.deepEqual(ack.data.outputs, { cancelled: 2 });
  assert.equal(asterisk.calls('DELETE', `/channels/${toMobile}`).length, 1);
  await destroyed(asterisk, toMobile, 16);
  await timers.advance(120_000);
  assert.equal(asterisk.calls('POST', '/channels').length, 2, 'no retry after a cancel');
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => event.data.result),
    ['cancelled', 'cancelled'],
  );
  app.stop();
});

test('an incoming call is reported, then sent back to the dialplan', async () => {
  const { gladys, asterisk, app } = await createWorld();
  const event = ariEvent('IncomingStasisStart');
  asterisk.socket.event(event);
  await settle();
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: 'call_received',
      data: { caller: '0600000001', caller_name: 'Alice', called: '5000' },
    },
  ]);
  assert.equal(lastText(gladys, 'last_caller'), '0600000001 (Alice)');
  assert.equal(asterisk.calls('POST', `/channels/${event.channel.id}/continue`).length, 1);
  app.stop();
});

test('in hangup mode, an incoming call is hung up without being answered', async () => {
  const { asterisk, app } = await createWorld({
    config: { ...BASE_CONFIG, incoming_mode: 'hangup' },
  });
  const event = ariEvent('IncomingStasisStart');
  event.channel.caller = { name: '', number: '' };
  asterisk.socket.event(event);
  await settle();
  assert.equal(asterisk.calls('DELETE', `/channels/${event.channel.id}`).length, 1);
  assert.equal(
    asterisk.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/channels/')).length,
    0,
  );
  app.stop();
});

test('a channel of ours left from before a restart is hung up, not reported', async () => {
  const { gladys, asterisk, app } = await createWorld();
  asterisk.socket.event(ariEvent('StasisStart', { channelId: 'gladys-old-1' }));
  await settle();
  assert.equal(asterisk.calls('DELETE', '/channels/gladys-old-1').length, 1);
  assert.deepEqual(gladys.fake.sceneEvents, []);
  app.stop();
});

test('losing the ARI link ends the calls in progress as failed', async () => {
  const { gladys, asterisk, app } = await createWorld();
  await gladys.fake.sceneAction('call', { ...ALARM, attempts: 3 });
  asterisk.socket.close();
  await settle();
  assert.equal(gladys.fake.sceneEvents.at(-1).data.result, 'failed');
  app.stop();
});

test('a call that never ends is hung up at the time limit', async () => {
  const { gladys, asterisk, timers, app } = await createWorld();
  await gladys.fake.sceneAction('call', { ...ALARM, attempts: 1 });
  const channelId = lastChannel(asterisk);
  await answer(asterisk, channelId);
  await timers.advance(5 * 60_000);
  assert.equal(asterisk.calls('DELETE', `/channels/${channelId}`).length, 1);
  assert.equal(gladys.fake.sceneEvents.at(-1).data.result, 'answered');
  app.stop();
});

test('Q.850 causes of an unanswered call', () => {
  assert.equal(unansweredResult(17), 'busy');
  assert.equal(unansweredResult(19), 'no_answer');
  assert.equal(unansweredResult(21), 'no_answer');
  assert.equal(unansweredResult(0), 'failed');
  assert.equal(unansweredResult(34), 'failed');
});
