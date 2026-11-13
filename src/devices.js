// -----------------------------------------------------------------------------
// The one device of the integration: the Asterisk server, with its link state,
// the last incoming call and the outcome of the last outgoing call.
//
// Gladys never polls it (should_poll: false): every value is pushed when it
// changes, and republished every 12 hours (heartbeat).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

// One server per integration: a fixed platform id keeps the ids stable when
// the user moves Asterisk to another machine.
export const SERVER_PLATFORM_ID = 'asterisk';

export const FEATURE_KEYS = {
  REACHABLE: 'reachable',
  LAST_CALLER: 'last_caller',
  LAST_CALL: 'last_call',
};

export const NAMES = {
  en: {
    device: 'Asterisk server',
    reachable: 'Server reachable',
    last_caller: 'Last incoming call',
    last_call: 'Last outgoing call',
  },
  fr: {
    device: 'Serveur Asterisk',
    reachable: 'Serveur joignable',
    last_caller: 'Dernier appel reçu',
    last_call: 'Dernier appel passé',
  },
  de: {
    device: 'Asterisk-Server',
    reachable: 'Server erreichbar',
    last_caller: 'Letzter eingehender Anruf',
    last_call: 'Letzter ausgehender Anruf',
  },
  es: {
    device: 'Servidor Asterisk',
    reachable: 'Servidor accesible',
    last_caller: 'Última llamada recibida',
    last_call: 'Última llamada realizada',
  },
};

// Outcome of an outgoing call, as shown in the "Last outgoing call" feature
// and in the widget.
export const RESULT_TEXT = {
  acknowledged: { en: 'acknowledged', fr: 'acquitté', de: 'bestätigt', es: 'confirmada' },
  answered: { en: 'answered', fr: 'décroché', de: 'angenommen', es: 'contestada' },
  no_answer: { en: 'no answer', fr: 'sans réponse', de: 'keine Antwort', es: 'sin respuesta' },
  busy: { en: 'busy', fr: 'occupé', de: 'besetzt', es: 'ocupado' },
  failed: { en: 'failed', fr: 'échec', de: 'fehlgeschlagen', es: 'error' },
  cancelled: { en: 'cancelled', fr: 'annulé', de: 'abgebrochen', es: 'cancelada' },
};

export const UNKNOWN_CALLER = {
  en: 'unknown number',
  fr: 'numéro masqué',
  de: 'unbekannte Nummer',
  es: 'número oculto',
};

const t = (table, language) => table[language] ?? table.en;

/** "0612345678 (Alice)", or the hidden-number text. */
export function callerText({ caller, caller_name: name }, language) {
  if (!caller) {
    return name || t(UNKNOWN_CALLER, language);
  }
  return name && name !== caller ? `${caller} (${name})` : caller;
}

/** "0612345678: acknowledged (2 attempts)". */
export function outcomeText({ number, result, attempts }, language) {
  const text = t(RESULT_TEXT[result] ?? RESULT_TEXT.failed, language);
  return attempts > 1 ? `${number}: ${text} (${attempts}×)` : `${number}: ${text}`;
}

export function serverIds(gladys) {
  return gladys.externalIds('server', SERVER_PLATFORM_ID);
}

/** The device published to Gladys. */
export function buildServerDevice(gladys, language) {
  const ids = serverIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  const text = (key) => ({
    name: names[key],
    external_id: ids.feature(key),
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    read_only: true,
    has_feedback: false,
    min: 0,
    max: 0,
  });
  return {
    name: names.device,
    external_id: ids.device,
    should_poll: false,
    features: [
      {
        name: names.reachable,
        external_id: ids.feature(FEATURE_KEYS.REACHABLE),
        category: DEVICE_FEATURE_CATEGORIES.INPUT,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        read_only: true,
        has_feedback: false,
        min: 0,
        max: 1,
      },
      text(FEATURE_KEYS.LAST_CALLER),
      text(FEATURE_KEYS.LAST_CALL),
    ],
  };
}
