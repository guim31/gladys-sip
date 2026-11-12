// -----------------------------------------------------------------------------
// The hub: keeps the ARI link to Asterisk open, turns calls into device states
// and scene events, and runs the scene actions.
//
// One reconnection loop: check the credentials with a REST call (a WebSocket
// refused by Asterisk says nothing about why), then open the event WebSocket.
// Every failure waits longer before the next try (5 s to 5 min) and is logged
// once, with one line on recovery.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AriClient } from './ari.js';
import { CallManager } from './calls.js';
import { isConfigured } from './config.js';
import { FEATURE_KEYS, buildServerDevice, callerText, outcomeText, serverIds } from './devices.js';

const logger = createLogger({ name: 'sip' });

export const WIDGET_KEY = 'sip';
export const TRIGGERS = { CALL_RECEIVED: 'call_received', CALL_FINISHED: 'call_finished' };

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  notConfigured: {
    en: 'Enter the address of Asterisk and the ARI user in the configuration.',
    fr: "Saisissez l'adresse d'Asterisk et l'utilisateur ARI dans la configuration.",
    de: 'Gib die Adresse von Asterisk und den ARI-Benutzer in der Konfiguration ein.',
    es: 'Introduzca la dirección de Asterisk y el usuario ARI en la configuración.',
  },
  badCredentials: {
    en: 'Asterisk refuses the ARI user or password.',
    fr: "Asterisk refuse l'utilisateur ou le mot de passe ARI.",
    de: 'Asterisk lehnt den ARI-Benutzer oder das Passwort ab.',
    es: 'Asterisk rechaza el usuario o la contraseña ARI.',
  },
  unreachable: {
    en: 'Asterisk does not answer: check the address and that ARI is enabled (http.conf, ari.conf).',
    fr: "Asterisk ne répond pas : vérifiez l'adresse et que ARI est activé (http.conf, ari.conf).",
    de: 'Asterisk antwortet nicht: Prüfe die Adresse und ob ARI aktiviert ist (http.conf, ari.conf).',
    es: 'Asterisk no responde: compruebe la dirección y que ARI esté activado (http.conf, ari.conf).',
  },
};

export const HUB_TIMINGS = {
  retryMinMs: 5_000,
  retryMaxMs: 5 * 60_000,
  // An event stream open this long is stable.
  stableMs: 60_000,
  // Values republished at least this often, or Gladys shows "no recent value".
  heartbeatMs: 12 * 3_600_000,
  heartbeatCheckMs: 3_600_000,
};

const connectionKey = (config) =>
  JSON.stringify([config.ari_url, config.ari_username, config.ari_password, config.ari_app]);

export class SipHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration
   * @param {typeof fetch} [options.fetch]
   * @param {(url: string) => WebSocket} [options.createSocket]
   * @param {object} [options.timers] { setTimeout, clearTimeout, setInterval, clearInterval }
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.callTimings] CALL_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, fetch, createSocket, timers, timings, callTimings, now }) {
    this.gladys = gladys;
    this.fetch = fetch;
    this.createSocket = createSocket;
    this.timers = timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.callTimings = callTimings;
    this.now = now ?? Date.now;
    this.config = null;
    this.ari = null;
    this.calls = null;
    this.socket = null;
    this.retryTimer = null;
    this.retryMs = this.timings.retryMinMs;
    this.failure = null; // key of the failure already logged
    this.connected = false;
    this.asteriskVersion = null;
    this.generation = 0;
    this.values = { [FEATURE_KEYS.REACHABLE]: 0 };
    this.lastIncoming = null;
    this.lastOutgoing = null;
    this.heartbeatTimer = null;
    this.lastFullPublish = this.now();
  }

  async start(config) {
    this.config = config;
    this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setInterval(
      () => this.heartbeat().catch(() => {}),
      this.timings.heartbeatCheckMs,
    );
    this.connect();
    // After connect(): a Gladys hiccup here must not leave Asterisk unwatched.
    await this.publishDevice();
  }

  async reconfigure(config) {
    if (!this.config) {
      // The first start failed: start again with the new settings.
      await this.start(config);
      return;
    }
    const reconnect = connectionKey(config) !== connectionKey(this.config);
    const relabel = config.language !== this.config.language;
    this.config = config;
    if (relabel) {
      await this.publishDevice();
    }
    if (reconnect) {
      logger.info('Connection settings changed, reconnecting to Asterisk');
      this.calls?.abandonAll({ hangup: true });
      this.disconnect();
      this.failure = null;
      this.retryMs = this.timings.retryMinMs;
      this.connect();
    }
  }

  async publishDevice() {
    await this.gladys.publishDiscoveredDevices([
      buildServerDevice(this.gladys, this.config.language),
    ]);
  }

  /** Republishes every value: a device just added to Gladys has none yet. */
  async onDeviceCreated() {
    await this.publishAll();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async publishValues() {
    const ids = serverIds(this.gladys);
    const states = Object.entries(this.values).map(([key, value]) =>
      typeof value === 'number'
        ? { device_feature_external_id: ids.feature(key), state: value }
        : { device_feature_external_id: ids.feature(key), text: value },
    );
    await this.gladys.publishChangedStates(states);
  }

  async publishAll() {
    this.gladys.forgetPublishedStates();
    this.lastFullPublish = this.now();
    await this.publishValues();
  }

  /** Values that do not change are republished, or Gladys shows "no recent value". */
  async heartbeat() {
    if (this.now() - this.lastFullPublish >= this.timings.heartbeatMs) {
      await this.publishAll();
    }
  }

  setValue(key, value) {
    this.values[key] = value;
    this.publishValues().catch((err) => logger.warn(`States not published: ${err.message}`));
  }

  connect() {
    this.disconnect();
    const generation = this.generation;
    if (!isConfigured(this.config)) {
      this.reportFailure('notConfigured', 'Asterisk is not configured yet');
      return;
    }
    this.ari = new AriClient({
      url: this.config.ari_url,
      username: this.config.ari_username,
      password: this.config.ari_password,
      app: this.config.ari_app,
      fetch: this.fetch,
      createSocket: this.createSocket,
    });
    this.calls = new CallManager({
      ari: this.ari,
      config: () => this.config,
      onFinished: (outcome) => this.callFinished(outcome),
      onIncoming: (call) => this.callReceived(call),
      timers: this.timers,
      timings: this.callTimings,
      now: this.now,
      logger,
    });
    this.ari
      .info()
      .then((info) => {
        if (generation !== this.generation) {
          return;
        }
        this.asteriskVersion = info.version;
        this.openSocket(generation);
      })
      .catch((err) => {
        if (generation !== this.generation) {
          return;
        }
        const reason = err.status === 401 || err.status === 403 ? 'badCredentials' : 'unreachable';
        this.reportFailure(reason, err.message);
        this.scheduleRetry(generation);
      });
  }

  openSocket(generation) {
    let socket;
    try {
      socket = this.ari.openEvents();
    } catch (err) {
      this.reportFailure('unreachable', `ARI events: ${err.message}`);
      this.scheduleRetry(generation);
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (generation === this.generation) {
        this.onOpen();
      }
    });
    socket.addEventListener('message', (message) => {
      if (generation !== this.generation) {
        return;
      }
      let event;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      this.calls.handleEvent(event);
    });
    socket.addEventListener('close', () => {
      if (generation !== this.generation) {
        return;
      }
      this.socket = null;
      const wasConnected = this.connected;
      this.connected = false;
      // A link that held a while starts the backoff again; a flapping one keeps it.
      if (wasConnected && this.now() - this.openedAt >= this.timings.stableMs) {
        this.retryMs = this.timings.retryMinMs;
      }
      this.calls.abandonAll();
      this.setValue(FEATURE_KEYS.REACHABLE, 0);
      this.reportFailure('unreachable', 'the ARI event stream closed', wasConnected);
      this.scheduleRetry(generation);
    });
    // An 'error' is always followed by 'close'.
    socket.addEventListener('error', () => {});
  }

  onOpen() {
    this.connected = true;
    this.openedAt = this.now();
    logger.info(
      `${this.failure ? 'Back in touch with' : 'Connected to'} Asterisk ${this.asteriskVersion ?? ''} (application "${this.config.ari_app}")`,
    );
    this.failure = null;
    this.setValue(FEATURE_KEYS.REACHABLE, 1);
    this.gladys.setConnectionStatus(true).catch(() => {});
    this.calls
      .hangupOrphans()
      .catch((err) => logger.debug(`Orphan channels not checked: ${err.message}`));
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** One log line and one status per kind of failure, not one per retry. */
  reportFailure(reason, detail, force = false) {
    if (this.failure === reason && !force) {
      logger.debug(`Asterisk still unavailable: ${detail}`);
      return;
    }
    this.failure = reason;
    logger.warn(`Asterisk unavailable: ${detail}`);
    this.setValue(FEATURE_KEYS.REACHABLE, 0);
    this.gladys.setConnectionStatus(false, CONNECTION_TEXT[reason]).catch(() => {});
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  scheduleRetry(generation) {
    if (generation !== this.generation) {
      return;
    }
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.timings.retryMaxMs);
    this.retryTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.generation += 1;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.calls?.stop();
    this.calls = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
    this.connected = false;
  }

  callReceived(call) {
    const at = new Date(this.now()).toISOString();
    this.lastIncoming = { ...call, at };
    logger.info(`Incoming call from ${call.caller || 'a hidden number'}`);
    this.setValue(FEATURE_KEYS.LAST_CALLER, callerText(call, this.config.language));
    this.gladys
      .publishSceneEvent(TRIGGERS.CALL_RECEIVED, {
        caller: call.caller,
        caller_name: call.caller_name,
        called: call.called,
      })
      .catch((err) => logger.warn(`Scene event not sent: ${err.message}`));
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  callFinished(outcome) {
    const at = new Date(this.now()).toISOString();
    this.lastOutgoing = { ...outcome, at };
    logger.info(
      `Call to ${outcome.number} ended: ${outcome.result} after ${outcome.attempts} attempt(s)`,
    );
    this.setValue(FEATURE_KEYS.LAST_CALL, outcomeText(outcome, this.config.language));
    this.gladys
      .publishSceneEvent(TRIGGERS.CALL_FINISHED, {
        number: outcome.number,
        result: outcome.result,
        attempts: outcome.attempts,
      })
      .catch((err) => logger.warn(`Scene event not sent: ${err.message}`));
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Starts a call campaign; throws when the link to Asterisk is down. */
  placeCall(request) {
    if (!this.connected || !this.calls) {
      throw new Error('Asterisk is not connected');
    }
    const outcome = this.calls.place(request);
    if (outcome.started) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
      logger.info(`Calling ${request.number} (up to ${request.attempts} attempt(s))`);
    }
    return outcome;
  }

  cancelCalls(number) {
    const count = this.calls ? this.calls.cancel(number) : 0;
    if (count > 0) {
      logger.info(`Cancelled ${count} call(s)${number ? ` to ${number}` : ''}`);
    }
    return count;
  }

  summary() {
    return {
      connected: this.connected,
      failure: this.failure,
      version: this.asteriskVersion,
      active: this.calls?.activeCount ?? 0,
      lastIncoming: this.lastIncoming,
      lastOutgoing: this.lastOutgoing,
    };
  }

  stop() {
    this.disconnect();
    this.timers.clearInterval(this.heartbeatTimer);
  }
}
