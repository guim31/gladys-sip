// -----------------------------------------------------------------------------
// Minimal client of the Asterisk REST Interface (ARI): a few REST calls and the
// event WebSocket of one Stasis application. No dependency: Node's fetch and
// WebSocket (global since Node 22).
//
// The WebSocket cannot carry an Authorization header, so ARI's `api_key` query
// parameter carries the credentials: the URL is a secret and is never logged.
// -----------------------------------------------------------------------------

export class AriError extends Error {
  /**
   * @param {string} message
   * @param {number|null} status HTTP status, null for a network error
   */
  constructor(message, status = null) {
    super(message);
    this.name = 'AriError';
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

export class AriClient {
  /**
   * @param {object} options
   * @param {string} options.url server root, e.g. http://pbx:8088
   * @param {string} options.username ARI user
   * @param {string} options.password ARI password
   * @param {string} options.app Stasis application name
   * @param {typeof fetch} [options.fetch]
   * @param {(url: string) => WebSocket} [options.createSocket]
   */
  constructor({ url, username, password, app, fetch: fetchImpl, createSocket }) {
    this.url = url;
    this.app = app;
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.apiKey = `${username}:${password}`;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.createSocket = createSocket ?? ((target) => new WebSocket(target));
  }

  /**
   * One REST call. Resolves the parsed JSON (null for an empty body), rejects
   * an AriError carrying the HTTP status.
   */
  async request(method, path, query = {}) {
    const url = new URL(`${this.url}/ari${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: { authorization: this.authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AriError(`ARI unreachable (${err.cause?.code ?? err.name})`, null);
    }
    const body = await response.text();
    if (!response.ok) {
      let detail = '';
      try {
        detail = JSON.parse(body).message ?? '';
      } catch {
        // Not JSON (a proxy page): the status says enough.
      }
      throw new AriError(
        `ARI ${method} ${path.split('?')[0]}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
        response.status,
      );
    }
    return body === '' ? null : JSON.parse(body);
  }

  /** Asterisk version and system name (GET /asterisk/info). */
  async info() {
    const info = await this.request('GET', '/asterisk/info');
    return {
      version: info?.system?.version ?? null,
      entityId: info?.system?.entity_id ?? null,
    };
  }

  /** Calls `endpoint` and, once answered, hands the channel to the Stasis application. */
  originate({ endpoint, channelId, callerId, timeout, appArgs }) {
    return this.request('POST', '/channels', {
      endpoint,
      app: this.app,
      appArgs,
      channelId,
      callerId,
      timeout,
    });
  }

  /** Plays a list of media (`sound:…`, `digits:…`…) one after the other. */
  play(channelId, media, playbackId) {
    return this.request(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/play/${encodeURIComponent(playbackId)}`,
      { media: media.join(',') },
    );
  }

  stopPlayback(playbackId) {
    return this.request('DELETE', `/playbacks/${encodeURIComponent(playbackId)}`);
  }

  hangup(channelId, reason) {
    return this.request('DELETE', `/channels/${encodeURIComponent(channelId)}`, { reason });
  }

  /** Sends the channel back to the dialplan, at the priority after Stasis(). */
  continueInDialplan(channelId) {
    return this.request('POST', `/channels/${encodeURIComponent(channelId)}/continue`);
  }

  /** Opens the event WebSocket of the application (the URL holds the credentials). */
  openEvents() {
    const url = new URL(`${this.url.replace(/^http/i, 'ws')}/ari/events`);
    url.searchParams.set('app', this.app);
    url.searchParams.set('api_key', this.apiKey);
    return this.createSocket(url.toString());
  }
}
