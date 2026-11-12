// -----------------------------------------------------------------------------
// Test world: the SDK's fake Gladys, a simulated Asterisk (ARI REST + event
// WebSocket) and manual timers, with the integration wired on top through
// registerHandlers. The ARI events replayed here were captured from Asterisk
// 23.5 (test/fixtures/ari-events.json).
// -----------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';

process.env.LOG_LEVEL ??= 'silent';
process.env.TZ = 'UTC';

export const ARI_EVENTS = JSON.parse(
  await readFile(new URL('../fixtures/ari-events.json', import.meta.url), 'utf8'),
);

export const BASE_CONFIG = {
  ari_url: 'http://192.0.2.10:8088',
  ari_username: 'gladys',
  ari_password: 'not-a-real-secret',
  endpoint: 'PJSIP/{number}@trunk',
  allowed_numbers: '+33 6 00 00 00 01, 100',
  language: 'en',
};

/** Timers driven by the test: nothing runs until advance(). */
export function manualTimers(clock) {
  let next = 1;
  const pending = new Map();
  const setTimeoutFn = (fn, ms) => {
    const id = next++;
    pending.set(id, { fn, at: clock.now + ms, every: null });
    return id;
  };
  const setIntervalFn = (fn, ms) => {
    const id = next++;
    pending.set(id, { fn, at: clock.now + ms, every: ms });
    return id;
  };
  const clear = (id) => pending.delete(id);
  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clear,
    setInterval: setIntervalFn,
    clearInterval: clear,
    pending,
    /** Moves the clock forward, firing what falls due, in order. */
    async advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        const [id, timer] = due;
        clock.now = timer.at;
        if (timer.every) {
          timer.at += timer.every;
        } else {
          pending.delete(id);
        }
        timer.fn();
        await settle();
      }
      clock.now = end;
      await settle();
    },
  };
}

/** Lets the pending promises run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A simulated Asterisk: answers the REST calls and pushes events on demand. */
export function fakeAsterisk({ status = 200, info = ARI_EVENTS.info } = {}) {
  const asterisk = {
    status,
    requests: [],
    sockets: [],
    failNext: null,
    get socket() {
      return asterisk.sockets.at(-1);
    },
    /** Requests to a path; a path ending with "/" matches every path below it. */
    calls(method, path) {
      return asterisk.requests.filter(
        (r) =>
          r.method === method && (path.endsWith('/') ? r.path.startsWith(path) : r.path === path),
      );
    },
    async fetch(url, options) {
      const target = new URL(url);
      const request = {
        method: options.method,
        path: target.pathname.replace(/^\/ari/, ''),
        query: Object.fromEntries(target.searchParams),
        authorization: options.headers.authorization,
      };
      asterisk.requests.push(request);
      if (asterisk.status === 'down') {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      }
      const failure = asterisk.failNext?.(request);
      const code = failure ?? (asterisk.status === 200 ? 200 : asterisk.status);
      if (code !== 200) {
        return new Response(JSON.stringify({ message: 'refused' }), { status: code });
      }
      if (request.path === '/asterisk/info') {
        return Response.json(info);
      }
      if (request.method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      return Response.json({ id: request.query.channelId ?? request.path.split('/').pop() });
    },
    createSocket(url) {
      const listeners = {};
      const socket = {
        url,
        closed: false,
        addEventListener(type, fn) {
          (listeners[type] ??= []).push(fn);
        },
        emit(type, event = {}) {
          for (const fn of listeners[type] ?? []) {
            fn(event);
          }
        },
        /** Pushes one ARI event. */
        event(payload) {
          socket.emit('message', { data: JSON.stringify(payload) });
        },
        close() {
          if (!socket.closed) {
            socket.closed = true;
            socket.emit('close');
          }
        },
      };
      asterisk.sockets.push(socket);
      return socket;
    },
  };
  return asterisk;
}

/** An ARI event of the fixtures, retargeted to a channel (and a playback). */
export function ariEvent(name, { channelId, playbackId, ...extra } = {}) {
  const event = structuredClone(ARI_EVENTS[name]);
  if (event.channel && channelId) {
    event.channel.id = channelId;
  }
  if (event.playback) {
    event.playback.id = playbackId;
    event.playback.target_uri = `channel:${channelId}`;
  }
  return { ...event, ...extra };
}

export async function createWorld({
  config = BASE_CONFIG,
  asterisk = fakeAsterisk(),
  devices = [],
  open = true,
  callTimings,
} = {}) {
  const clock = { now: Date.UTC(2026, 10, 12, 8, 30) };
  const timers = manualTimers(clock);
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    fetch: asterisk.fetch,
    createSocket: asterisk.createSocket,
    timers,
    now: () => clock.now,
    callTimings,
  });
  await gladys.connect();
  await app.ready;
  await settle();
  if (open && asterisk.socket) {
    asterisk.socket.emit('open');
    await settle();
  }
  return { gladys, app, hub: app.hub, asterisk, timers, clock };
}
