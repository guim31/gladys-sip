// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `sip`.
//
// What the device box cannot show: the calls in progress, when the last calls
// happened, and a button to stop every call (the alarm was a false one). The
// button only appears while a call is in progress, and a setting hides it.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { callerText, outcomeText } from './devices.js';
import { WIDGET_KEY } from './hub.js';

export const CANCEL_ACTION = 'cancel_calls';

export const TEXT = {
  server: { en: 'Asterisk', fr: 'Asterisk', de: 'Asterisk', es: 'Asterisk' },
  connected: { en: 'connected', fr: 'connecté', de: 'verbunden', es: 'conectado' },
  unreachable: { en: 'unreachable', fr: 'injoignable', de: 'nicht erreichbar', es: 'inaccesible' },
  active: {
    en: 'Calls in progress',
    fr: 'Appels en cours',
    de: 'Laufende Anrufe',
    es: 'Llamadas en curso',
  },
  incoming: {
    en: 'Last received',
    fr: 'Dernier reçu',
    de: 'Zuletzt empfangen',
    es: 'Última recibida',
  },
  outgoing: {
    en: 'Last placed',
    fr: 'Dernier passé',
    de: 'Zuletzt gewählt',
    es: 'Última realizada',
  },
  none: { en: 'none', fr: 'aucun', de: 'keiner', es: 'ninguna' },
  cancel: {
    en: 'Stop the calls',
    fr: 'Arrêter les appels',
    de: 'Anrufe stoppen',
    es: 'Detener llamadas',
  },
  cancelled: {
    en: 'Calls stopped: ',
    fr: 'Appels arrêtés : ',
    de: 'Anrufe gestoppt: ',
    es: 'Llamadas detenidas: ',
  },
};

const t = (text, language) => text[language] ?? text.en;
const cut = (text) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

function time(at, language) {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  );
}

export function widgetContent(summary, settings = {}, language = 'en') {
  const lang = ['en', 'fr', 'de', 'es'].includes(language) ? language : 'en';
  const items = [
    {
      label: t(TEXT.server, lang),
      value: summary.connected
        ? cut(`${t(TEXT.connected, lang)}${summary.version ? ` (${summary.version})` : ''}`)
        : t(TEXT.unreachable, lang),
      icon: 'server',
      color: summary.connected ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
    },
    {
      label: t(TEXT.active, lang),
      value: summary.active,
      icon: 'phone-outgoing',
      color: summary.active > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
    {
      label: t(TEXT.incoming, lang),
      value: summary.lastIncoming
        ? cut(`${time(summary.lastIncoming.at, lang)} · ${callerText(summary.lastIncoming, lang)}`)
        : t(TEXT.none, lang),
      icon: 'phone-incoming',
      color: WIDGET_COLORS.INFO,
    },
    {
      label: t(TEXT.outgoing, lang),
      value: summary.lastOutgoing
        ? cut(`${time(summary.lastOutgoing.at, lang)} · ${outcomeText(summary.lastOutgoing, lang)}`)
        : t(TEXT.none, lang),
      icon: 'phone-call',
      color:
        summary.lastOutgoing?.result === 'acknowledged' ||
        summary.lastOutgoing?.result === 'answered'
          ? WIDGET_COLORS.SUCCESS
          : summary.lastOutgoing
            ? WIDGET_COLORS.WARNING
            : WIDGET_COLORS.NEUTRAL,
    },
  ];
  const components = [{ type: 'status', items }];
  if (summary.active > 0 && settings.show_cancel !== false) {
    components.push({
      type: 'button',
      label: TEXT.cancel,
      icon: 'phone-off',
      style: 'danger',
      action: { key: CANCEL_ACTION, confirm: true },
    });
  }
  // A call in progress moves fast; at rest, the nudges keep the card fresh.
  return { ttl_seconds: summary.active > 0 ? 10 : 300, components };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    get: (hub, { settings, language }) => widgetContent(hub.summary(), settings, language),
    action: (hub, { actionKey }) => {
      if (actionKey !== CANCEL_ACTION) {
        throw new Error(`Unknown widget action ${actionKey}`);
      }
      const count = hub.cancelCalls(null);
      return Object.fromEntries(
        Object.entries(TEXT.cancelled).map(([lang, text]) => [lang, `${text}${count}`]),
      );
    },
  },
};
