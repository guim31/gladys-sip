// -----------------------------------------------------------------------------
// Integration configuration: defaults (mirroring the manifest `config_schema`)
// and normalization, so the rest of the code never deals with `undefined`,
// strings typed in a form or a trailing slash.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const INCOMING_MODES = ['continue', 'hangup'];

// Defaults: they MUST stay consistent with the `default` values of the
// manifest `config_schema` (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  ari_url: '',
  ari_username: '',
  ari_password: '',
  ari_app: 'gladys',
  endpoint: 'PJSIP/{number}@trunk',
  caller_id: '',
  allowed_numbers: '',
  incoming_mode: 'continue',
  language: 'fr',
};

// Phone numbers and extensions: an optional "+", then digits (and * or #, for
// feature codes). Separators people type are removed first.
const NUMBER = /^\+?[0-9*#]{2,20}$/;
const SEPARATORS = /[\s.\-()/]/g;

/** "06 12-34.56 78" → "0612345678"; null when it is not a phone number. */
export function normalizeNumber(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  const number = String(raw).replace(SEPARATORS, '');
  return NUMBER.test(number) ? number : null;
}

/** The allow-list: valid numbers, de-duplicated, and the entries refused. */
export function parseNumberList(raw) {
  const numbers = [];
  const invalid = [];
  for (const entry of String(raw ?? '').split(/[,;\n]/)) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    const number = normalizeNumber(trimmed);
    if (number === null) {
      invalid.push(trimmed);
    } else if (!numbers.includes(number)) {
      numbers.push(number);
    }
  }
  return { numbers, invalid };
}

/** "http://pbx:8088/" or "pbx:8088" → "http://pbx:8088"; null when unusable. */
export function normalizeAriUrl(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return null;
  }
  if (!/^https?:\/\//i.test(text)) {
    text = `http://${text}`;
  }
  try {
    const url = new URL(text);
    // Credentials go in their own fields, never in the address.
    if (url.username || url.password) {
      return null;
    }
    // Users often paste the ARI path: keep only the server root.
    const path = url.pathname.replace(/\/+$/, '').replace(/\/ari$/i, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} raw config returned by the SDK */
export function normalizeConfig(raw = {}) {
  const text = (key) => String(raw[key] ?? DEFAULT_CONFIG[key]).trim();
  const endpoint = text('endpoint');
  const app = text('ari_app');
  return {
    ari_url: normalizeAriUrl(raw.ari_url),
    ari_username: text('ari_username'),
    ari_password: String(raw.ari_password ?? ''),
    ari_app: /^[A-Za-z0-9_-]{1,64}$/.test(app) ? app : DEFAULT_CONFIG.ari_app,
    endpoint: endpoint.includes('{number}') ? endpoint : DEFAULT_CONFIG.endpoint,
    caller_id: text('caller_id'),
    allowed_numbers: parseNumberList(raw.allowed_numbers).numbers,
    incoming_mode: INCOMING_MODES.includes(raw.incoming_mode)
      ? raw.incoming_mode
      : DEFAULT_CONFIG.incoming_mode,
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
  };
}

/** True when the connection fields are filled in. */
export function isConfigured(config) {
  return Boolean(config.ari_url && config.ari_username && config.ari_password);
}
