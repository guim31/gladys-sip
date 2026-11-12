// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { CONNECTION_TEXT, SipHub } from './hub.js';
import { SCENE_ACTIONS, callRequest } from './scenes.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'sip-app' });

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Messages shown under the buttons of the Configuration screen.
export const ACTION_TEXT = {
  en: {
    connected: (version) => `Connected to Asterisk ${version}, ARI events received.`,
    notConnected: 'Not connected to Asterisk:',
    callStarted: (number) => `Calling ${number}: the outcome shows in "Last outgoing call".`,
    alreadyCalling: (number) => `A call to ${number} is already in progress.`,
    tooMany: 'Too many calls in progress, try again later.',
    refused: 'Call refused:',
  },
  fr: {
    connected: (version) => `Connecté à Asterisk ${version}, événements ARI reçus.`,
    notConnected: 'Pas de connexion à Asterisk :',
    callStarted: (number) =>
      `Appel de ${number} lancé : le résultat s'affiche dans « Dernier appel passé ».`,
    alreadyCalling: (number) => `Un appel vers ${number} est déjà en cours.`,
    tooMany: 'Trop d’appels en cours, réessayez plus tard.',
    refused: 'Appel refusé :',
  },
  de: {
    connected: (version) => `Mit Asterisk ${version} verbunden, ARI-Ereignisse kommen an.`,
    notConnected: 'Keine Verbindung zu Asterisk:',
    callStarted: (number) =>
      `${number} wird angerufen: Das Ergebnis erscheint unter „Letzter ausgehender Anruf“.`,
    alreadyCalling: (number) => `Ein Anruf an ${number} läuft bereits.`,
    tooMany: 'Zu viele laufende Anrufe, versuche es später erneut.',
    refused: 'Anruf abgelehnt:',
  },
  es: {
    connected: (version) => `Conectado a Asterisk ${version}, se reciben los eventos ARI.`,
    notConnected: 'Sin conexión con Asterisk:',
    callStarted: (number) =>
      `Llamando a ${number}: el resultado aparece en «Última llamada realizada».`,
    alreadyCalling: (number) => `Ya hay una llamada en curso a ${number}.`,
    tooMany: 'Demasiadas llamadas en curso, inténtelo más tarde.',
    refused: 'Llamada rechazada:',
  },
};

const allLanguages = (render) =>
  Object.fromEntries(Object.entries(ACTION_TEXT).map(([lang, text]) => [lang, render(text, lang)]));

/** Message of the "Test the connection" button. */
export function connectionMessage(hub) {
  const summary = hub.summary();
  if (summary.connected) {
    return allLanguages((text) => text.connected(summary.version ?? ''));
  }
  const reason = CONNECTION_TEXT[summary.failure] ?? CONNECTION_TEXT.unreachable;
  return allLanguages((text, lang) => `${text.notConnected} ${reason[lang]}`);
}

/** Message of the "Test call" button. */
export function testCallMessage(hub, fields) {
  let outcome;
  try {
    const request = callRequest(
      { number: fields.number, message: fields.message, repeat: 1, attempts: 1 },
      hub.config,
    );
    outcome = { ...hub.placeCall(request), number: request.number };
  } catch (err) {
    return allLanguages((text) => `${text.refused} ${err.message}.`);
  }
  if (outcome.started) {
    return allLanguages((text) => text.callStarted(outcome.number));
  }
  return allLanguages((text) =>
    outcome.reason === 'already_calling' ? text.alreadyCalling(outcome.number) : text.tooMany,
  );
}

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: fetch, createSocket, timers, timings, callTimings, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new SipHub({ gladys, ...options });

  // Resolved once the hub has started; every handler waits for it.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      if (started && hub.config) {
        // Gladys restarted: what it may have lost is republished.
        await hub.publishDevice();
        await hub.onDeviceCreated();
        return;
      }
      started = true;
      await hub.start(normalizeConfig(await gladys.getConfig()));
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.publishDevice()));
  // Nothing to poll (should_poll: false): every value is pushed.
  gladys.onPoll(whenReady(() => hub.publishValues()));
  gladys.onDeviceCreated(whenReady(() => hub.onDeviceCreated()));
  gladys.onDeviceUpdated(whenReady(() => gladys.requestWidgetRefresh('sip')));
  gladys.onConfigUpdated(whenReady((config) => hub.reconfigure(normalizeConfig(config))));

  gladys.onAction(
    'test_connection',
    whenReady(() => connectionMessage(hub)),
  );
  gladys.onAction(
    'test_call',
    whenReady((fields) => testCallMessage(hub, fields)),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }

  return { hub, ready, stop: () => hub.stop() };
}
