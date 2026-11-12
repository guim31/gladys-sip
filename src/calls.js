// -----------------------------------------------------------------------------
// Call logic over ARI, without any Gladys knowledge.
//
// Outgoing: a "campaign" calls one number up to `attempts` times. Each attempt
// originates a channel straight into the Stasis application; once answered,
// the message (a list of media) is played `repeat` times. When an
// acknowledgement is required, the callee presses 1 (DTMF) to stop the
// campaign; otherwise being answered is enough.
//
// Incoming: any other channel entering the application is a call routed by the
// dialplan (`Stasis(gladys)`). It is reported, then sent back to the dialplan
// (it keeps ringing the phones) or hung up without being answered.
//
// The channel ids are chosen here (`gladys-<campaign>-<attempt>`), so an event
// arriving before the originate response is never mistaken for another call.
// -----------------------------------------------------------------------------

export const RESULTS = ['acknowledged', 'answered', 'no_answer', 'busy', 'failed', 'cancelled'];

export const ACK_DIGIT = '1';
export const CHANNEL_PREFIX = 'gladys-';
export const OUTGOING_ARG = 'gladys-outgoing';
export const MAX_CAMPAIGNS = 5;

export const CALL_TIMINGS = {
  // Silence between two plays of the message.
  pauseMs: 1_000,
  // Time left to press 1 after the last play, before hanging up.
  ackWaitMs: 10_000,
  // Hard limit of one attempt, ringing included (a playback that never ends).
  maxAttemptMs: 5 * 60_000,
};

// Q.850 causes of a call that ended before being answered.
const BUSY_CAUSES = new Set([17]);
const NO_ANSWER_CAUSES = new Set([16, 18, 19, 21, 31]);

/** Result of an attempt that ended before being answered. */
export function unansweredResult(cause) {
  if (BUSY_CAUSES.has(cause)) {
    return 'busy';
  }
  return NO_ANSWER_CAUSES.has(cause) ? 'no_answer' : 'failed';
}

export class CallManager {
  /**
   * @param {object} options
   * @param {import('./ari.js').AriClient} options.ari
   * @param {() => object} options.config normalized config (read at each call)
   * @param {(outcome: object) => void} options.onFinished a campaign ended
   * @param {(call: object) => void} options.onIncoming an incoming call arrived
   * @param {object} [options.timers] { setTimeout, clearTimeout }
   * @param {object} [options.timings] CALL_TIMINGS overrides
   * @param {() => number} [options.now] clock
   * @param {object} options.logger
   */
  constructor({ ari, config, onFinished, onIncoming, timers, timings, now, logger }) {
    this.now = now ?? Date.now;
    this.ari = ari;
    this.config = config;
    this.onFinished = onFinished;
    this.onIncoming = onIncoming;
    this.timers = timers ?? { setTimeout, clearTimeout };
    this.timings = { ...CALL_TIMINGS, ...timings };
    this.logger = logger;
    this.campaigns = new Map();
    this.channels = new Map();
    this.sequence = 0;
  }

  get activeCount() {
    return this.campaigns.size;
  }

  /**
   * Starts a campaign. Resolves at once: the outcome comes through onFinished.
   * @returns {{ started: boolean, id?: string, reason?: string }}
   */
  place({ number, media, repeat, attempts, retryDelayMs, ringTimeoutS, requireAck }) {
    for (const campaign of this.campaigns.values()) {
      if (campaign.number === number) {
        // An alarm scene firing twice must not ring the phone twice.
        return { started: false, id: campaign.id, reason: 'already_calling' };
      }
    }
    if (this.campaigns.size >= MAX_CAMPAIGNS) {
      return { started: false, reason: 'too_many_calls' };
    }
    this.sequence += 1;
    const id = `${this.now().toString(36)}${this.sequence}`;
    const campaign = {
      id,
      number,
      media,
      repeat,
      attempts,
      retryDelayMs,
      ringTimeoutS,
      requireAck,
      attempt: 0,
      cancelled: false,
      retryTimer: null,
      channelId: null,
    };
    this.campaigns.set(id, campaign);
    this.startAttempt(campaign);
    return { started: true, id };
  }

  /** Stops the campaigns to `number` (every campaign without it). */
  cancel(number) {
    let count = 0;
    for (const campaign of [...this.campaigns.values()]) {
      if (number && campaign.number !== number) {
        continue;
      }
      count += 1;
      campaign.cancelled = true;
      if (campaign.channelId) {
        // The ChannelDestroyed event ends the campaign.
        this.hangup(campaign.channelId);
      } else {
        this.timers.clearTimeout(campaign.retryTimer);
        this.finish(campaign, 'cancelled');
      }
    }
    return count;
  }

  startAttempt(campaign) {
    campaign.attempt += 1;
    campaign.retryTimer = null;
    const channelId = `${CHANNEL_PREFIX}${campaign.id}-${campaign.attempt}`;
    const config = this.config();
    const call = {
      channelId,
      campaign,
      answered: false,
      acknowledged: false,
      plays: 0,
      playbackId: null,
      timers: new Set(),
    };
    campaign.channelId = channelId;
    this.channels.set(channelId, call);
    this.later(call, this.timings.maxAttemptMs, () => {
      this.logger.warn(`Call ${campaign.id}: attempt over the time limit, hanging up`);
      this.endAttempt(call, call.answered ? 'answered' : 'no_answer');
      this.hangup(channelId);
    });
    this.logger.debug(`Call ${campaign.id}: attempt ${campaign.attempt}/${campaign.attempts}`);
    this.ari
      .originate({
        endpoint: config.endpoint.replaceAll('{number}', campaign.number),
        channelId,
        callerId: config.caller_id || undefined,
        timeout: campaign.ringTimeoutS,
        appArgs: OUTGOING_ARG,
      })
      .catch((err) => {
        this.logger.warn(`Call ${campaign.id}: the call could not be placed: ${err.message}`);
        this.endAttempt(call, 'failed');
      });
  }

  /** Routes one ARI event. */
  handleEvent(event) {
    const channelId = event.channel?.id ?? event.playback?.target_uri?.replace(/^channel:/, '');
    const call = channelId ? this.channels.get(channelId) : undefined;
    switch (event.type) {
      case 'StasisStart':
        if (call) {
          this.answered(call);
        } else {
          this.incoming(event);
        }
        break;
      case 'PlaybackFinished':
        if (call && event.playback.id === call.playbackId) {
          this.playFinished(call);
        }
        break;
      case 'ChannelDtmfReceived':
        if (call) {
          this.dtmf(call, event.digit);
        }
        break;
      case 'ChannelDestroyed':
        if (call) {
          const result = call.acknowledged
            ? 'acknowledged'
            : call.answered
              ? 'answered'
              : unansweredResult(event.cause);
          this.logger.debug(
            `Call ${call.campaign.id}: channel ended (cause ${event.cause} ${event.cause_txt ?? ''})`,
          );
          this.endAttempt(call, result);
        }
        break;
      default:
        break;
    }
  }

  answered(call) {
    call.answered = true;
    this.logger.debug(`Call ${call.campaign.id}: answered`);
    this.playNext(call);
  }

  playNext(call) {
    if (call.ended || call.acknowledged) {
      return;
    }
    call.plays += 1;
    call.playbackId = `${call.channelId}-p${call.plays}`;
    this.ari.play(call.channelId, call.campaign.media, call.playbackId).catch((err) => {
      this.logger.warn(`Call ${call.campaign.id}: the message could not be played: ${err.message}`);
      this.hangup(call.channelId);
    });
  }

  playFinished(call) {
    if (call.ended || call.acknowledged) {
      return;
    }
    if (call.plays < call.campaign.repeat) {
      this.later(call, this.timings.pauseMs, () => this.playNext(call));
    } else if (call.campaign.requireAck) {
      this.later(call, this.timings.ackWaitMs, () => this.hangup(call.channelId));
    } else {
      this.hangup(call.channelId);
    }
  }

  dtmf(call, digit) {
    if (!call.answered || !call.campaign.requireAck || call.acknowledged || digit !== ACK_DIGIT) {
      return;
    }
    call.acknowledged = true;
    this.logger.debug(`Call ${call.campaign.id}: acknowledged`);
    if (call.playbackId) {
      this.ari.stopPlayback(call.playbackId).catch(() => {});
    }
    this.hangup(call.channelId);
  }

  incoming(event) {
    const { channel } = event;
    if (channel.id.startsWith(CHANNEL_PREFIX) || event.args?.[0] === OUTGOING_ARG) {
      // One of our calls from before a restart: nobody follows it any more.
      this.hangup(channel.id);
      return;
    }
    const config = this.config();
    this.onIncoming({
      caller: channel.caller?.number || '',
      caller_name: channel.caller?.name || '',
      called: channel.dialplan?.exten || '',
    });
    const next =
      config.incoming_mode === 'hangup'
        ? this.ari.hangup(channel.id)
        : this.ari.continueInDialplan(channel.id);
    next.catch((err) => {
      this.logger.warn(`Incoming call: the call could not be released: ${err.message}`);
    });
  }

  endAttempt(call, result) {
    if (call.ended) {
      return;
    }
    call.ended = true;
    for (const timer of call.timers) {
      this.timers.clearTimeout(timer);
    }
    this.channels.delete(call.channelId);
    const { campaign } = call;
    campaign.channelId = null;
    campaign.lastResult = result;
    if (!this.campaigns.has(campaign.id)) {
      return;
    }
    const success = result === 'acknowledged' || (result === 'answered' && !campaign.requireAck);
    if (campaign.cancelled) {
      this.finish(campaign, 'cancelled');
    } else if (success || campaign.attempt >= campaign.attempts) {
      this.finish(campaign, result);
    } else {
      this.logger.debug(`Call ${campaign.id}: ${result}, next attempt later`);
      campaign.retryTimer = this.timers.setTimeout(
        () => this.startAttempt(campaign),
        campaign.retryDelayMs,
      );
    }
  }

  finish(campaign, result) {
    this.campaigns.delete(campaign.id);
    this.onFinished({
      id: campaign.id,
      number: campaign.number,
      result,
      attempts: campaign.attempt,
    });
  }

  later(call, ms, fn) {
    const timer = this.timers.setTimeout(() => {
      call.timers.delete(timer);
      fn();
    }, ms);
    call.timers.add(timer);
  }

  hangup(channelId) {
    this.ari.hangup(channelId).catch((err) => {
      // 404: already gone, the ChannelDestroyed event follows or has passed.
      if (err.status !== 404) {
        this.logger.debug(`Hangup of ${channelId} failed: ${err.message}`);
      }
    });
  }

  /**
   * The ARI link is lost: calls in progress can no longer be followed, and a
   * retry could not be placed. Every campaign ends as failed (acknowledged if
   * the callee already pressed 1).
   */
  abandonAll() {
    for (const call of this.channels.values()) {
      call.ended = true;
      for (const timer of call.timers) {
        this.timers.clearTimeout(timer);
      }
      call.campaign.lastResult = call.acknowledged ? 'acknowledged' : 'failed';
    }
    this.channels.clear();
    for (const campaign of [...this.campaigns.values()]) {
      this.timers.clearTimeout(campaign.retryTimer);
      this.finish(campaign, campaign.lastResult === 'acknowledged' ? 'acknowledged' : 'failed');
    }
  }

  /** Stops every timer (shutdown). Calls in progress are hung up. */
  stop() {
    for (const campaign of this.campaigns.values()) {
      campaign.cancelled = true;
      this.timers.clearTimeout(campaign.retryTimer);
    }
    for (const call of this.channels.values()) {
      for (const timer of call.timers) {
        this.timers.clearTimeout(timer);
      }
      this.hangup(call.channelId);
    }
    this.channels.clear();
    this.campaigns.clear();
  }
}
