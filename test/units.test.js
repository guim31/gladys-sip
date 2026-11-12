// -----------------------------------------------------------------------------
// Pure helpers: configuration, scene action fields, widget content.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  DEFAULT_CONFIG,
  normalizeAriUrl,
  normalizeConfig,
  normalizeNumber,
  parseNumberList,
} from '../src/config.js';
import { callerText, outcomeText } from '../src/devices.js';
import { callRequest, parseMedia } from '../src/scenes.js';
import { widgetContent } from '../src/widgets.js';
import { BASE_CONFIG, createWorld } from './helpers/world.js';

test('phone numbers: separators removed, anything else refused', () => {
  assert.equal(normalizeNumber('06 12-34.56 78'), '0612345678');
  assert.equal(normalizeNumber('+33 (0)6 12 34 56 78'), '+330612345678');
  assert.equal(normalizeNumber('100'), '100');
  assert.equal(normalizeNumber('*97'), '*97');
  assert.equal(normalizeNumber('0612abc'), null);
  assert.equal(normalizeNumber('6'), null);
  assert.equal(normalizeNumber('PJSIP/100'), null);
  assert.equal(normalizeNumber(undefined), null);
  assert.deepEqual(parseNumberList('06 12 34 56 78; 100,\n100, abc'), {
    numbers: ['0612345678', '100'],
    invalid: ['abc'],
  });
});

test('ARI address: scheme added, ARI path and slash removed, no credentials', () => {
  assert.equal(normalizeAriUrl('192.0.2.10:8088'), 'http://192.0.2.10:8088');
  assert.equal(normalizeAriUrl('https://pbx.example:8089/ari/'), 'https://pbx.example:8089');
  assert.equal(normalizeAriUrl('http://user:pass@192.0.2.10:8088'), null);
  assert.equal(normalizeAriUrl(''), null);
});

test('config: defaults, then the typed values', () => {
  assert.deepEqual(normalizeConfig({}), {
    ...DEFAULT_CONFIG,
    ari_url: null,
    allowed_numbers: [],
  });
  const config = normalizeConfig({
    ...BASE_CONFIG,
    ari_app: 'bad app!',
    endpoint: 'PJSIP/trunk',
    incoming_mode: 'other',
    language: 'it',
  });
  assert.equal(config.ari_app, 'gladys');
  assert.equal(config.endpoint, DEFAULT_CONFIG.endpoint, 'a dial string without {number}');
  assert.equal(config.incoming_mode, 'continue');
  assert.equal(config.language, 'fr');
  assert.deepEqual(config.allowed_numbers, ['+33600000001', '100']);
});

test('message: Asterisk sounds and ARI media, never a URL or a path out', () => {
  assert.deepEqual(parseMedia('custom/alarm, digits:1234 ; tone:ring'), [
    'sound:custom/alarm',
    'digits:1234',
    'tone:ring',
  ]);
  assert.equal(parseMedia(''), null);
  assert.equal(parseMedia('sound:http://evil.example/x.wav'), null);
  assert.equal(parseMedia('../../etc/passwd'), null);
  assert.equal(parseMedia('file:custom/alarm'), null);
  assert.equal(parseMedia(Array(11).fill('beep').join(',')), null);
});

test('call fields: allow-list, limits, defaults', () => {
  const config = normalizeConfig(BASE_CONFIG);
  assert.deepEqual(callRequest({ number: '+33 6 00 00 00 01', message: 'custom/alarm' }, config), {
    number: '+33600000001',
    media: ['sound:custom/alarm'],
    repeat: 2,
    attempts: 3,
    retryDelayMs: 60_000,
    ringTimeoutS: 30,
    requireAck: false,
  });
  assert.throws(
    () => callRequest({ number: '0899000000', message: 'x' }, config),
    /not in the allowed numbers/,
  );
  assert.throws(() => callRequest({ number: '100', message: '' }, config), /message/);
  assert.throws(
    () => callRequest({ number: '100', message: 'x', attempts: 50 }, config),
    /1 to 10/,
  );
  assert.throws(() => callRequest({ number: '100', message: 'x', repeat: 1.5 }, config), /repeat/);
});

test('texts of the device features', () => {
  assert.equal(callerText({ caller: '100', caller_name: '100' }, 'en'), '100');
  assert.equal(callerText({ caller: '', caller_name: '' }, 'fr'), 'numéro masqué');
  assert.equal(
    outcomeText({ number: '100', result: 'busy', attempts: 3 }, 'de'),
    '100: besetzt (3×)',
  );
});

test('the widget content is valid for the core, in every state', () => {
  const at = '2026-11-12T08:30:00.000Z';
  const summaries = [
    { connected: false, active: 0, lastIncoming: null, lastOutgoing: null },
    {
      connected: true,
      version: '23.5.0',
      active: 2,
      lastIncoming: { caller: '0600000001', caller_name: 'A very long caller name, cut', at },
      lastOutgoing: { number: '+33600000001', result: 'no_answer', attempts: 3, at },
    },
  ];
  for (const summary of summaries) {
    for (const language of ['en', 'fr', 'de', 'es']) {
      const content = widgetContent(summary, {}, language);
      assert.deepEqual(validateWidgetContent(content), [], JSON.stringify(content));
      for (const item of content.components[0].items) {
        assert.ok(String(item.value).length <= 40, item.value);
      }
    }
  }
  const busy = widgetContent(summaries[1], {}, 'fr');
  assert.equal(busy.components[1].action.key, 'cancel_calls');
  assert.match(busy.components[0].items[2].value, /^08:30 · 0600000001/);
  assert.equal(widgetContent(summaries[1], { show_cancel: false }).components.length, 1);
  assert.equal(widgetContent(summaries[0]).components.length, 1, 'no call, no button');
});

test('the widget button stops every call', async () => {
  const { gladys, app } = await createWorld();
  await gladys.fake.sceneAction('call', { number: '100', message: 'custom/alarm' });
  const ack = await gladys.fake.widgetAction('sip', 'cancel_calls', {}, { settings: {} });
  assert.equal(ack.data.message.fr, 'Appels arrêtés : 1');
  app.stop();
});
