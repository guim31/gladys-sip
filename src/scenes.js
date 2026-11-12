// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// `call` only starts the call and resolves at once: with retries, a campaign
// lasts longer than the 120 s a scene action may take. Its outcome comes back
// as the `call_finished` trigger and the "Last outgoing call" feature.
// -----------------------------------------------------------------------------

import { normalizeNumber } from './config.js';

// The ARI media kinds a message may use; a bare name is an Asterisk sound.
const MEDIA_KINDS = ['sound', 'recording', 'digits', 'number', 'characters', 'tone'];
const MEDIA_VALUE = /^[A-Za-z0-9_\-/.#*|]+$/;
export const MAX_MEDIA = 10;

export const CALL_LIMITS = {
  repeat: { default: 2, min: 1, max: 5 },
  attempts: { default: 3, min: 1, max: 10 },
  retry_delay: { default: 60, min: 0, max: 3600 },
  ring_timeout: { default: 30, min: 10, max: 120 },
};

/**
 * "custom/alarm, digits:1234" → ["sound:custom/alarm", "digits:1234"];
 * null when an item is not a local media (no URL, no "..").
 */
export function parseMedia(raw) {
  const items = String(raw ?? '')
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0 || items.length > MAX_MEDIA) {
    return null;
  }
  const media = [];
  for (const item of items) {
    const match = item.match(/^([a-z]+):(.*)$/);
    const [kind, value] = match ? [match[1], match[2]] : ['sound', item];
    if (!MEDIA_KINDS.includes(kind) || !MEDIA_VALUE.test(value) || value.includes('..')) {
      return null;
    }
    media.push(`${kind}:${value}`);
  }
  return media;
}

/** An integer within its limits; the default when empty, an error otherwise. */
function bounded(fields, key) {
  const limits = CALL_LIMITS[key];
  const raw = fields[key];
  if (raw === undefined || raw === null || raw === '') {
    return limits.default;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    throw new Error(`${key} must be a whole number from ${limits.min} to ${limits.max}`);
  }
  return value;
}

/** Validates the fields of `call` against the allow-list; throws on refusal. */
export function callRequest(fields, config) {
  const number = normalizeNumber(fields.number);
  if (!number) {
    throw new Error('The number is not a phone number');
  }
  if (!config.allowed_numbers.includes(number)) {
    throw new Error(`${number} is not in the allowed numbers of the integration`);
  }
  const media = parseMedia(fields.message);
  if (!media) {
    throw new Error(
      'The message must list 1 to 10 Asterisk sounds, such as custom/alarm (no URL, no "..")',
    );
  }
  return {
    number,
    media,
    repeat: bounded(fields, 'repeat'),
    attempts: bounded(fields, 'attempts'),
    retryDelayMs: bounded(fields, 'retry_delay') * 1000,
    ringTimeoutS: bounded(fields, 'ring_timeout'),
    requireAck: fields.require_ack === true || fields.require_ack === 'true',
  };
}

export const SCENE_ACTIONS = {
  call: (hub, { fields }) => {
    const outcome = hub.placeCall(callRequest(fields, hub.config));
    return { started: outcome.started, call_id: outcome.id ?? '' };
  },
  cancel_calls: (hub, { fields }) => {
    const raw = String(fields.number ?? '').trim();
    const number = raw === '' ? null : normalizeNumber(raw);
    if (raw !== '' && !number) {
      throw new Error('The number is not a phone number');
    }
    return { cancelled: hub.cancelCalls(number) };
  },
};
