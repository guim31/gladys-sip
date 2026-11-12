# SIP voice calls (Asterisk) for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that places and watches phone calls
through **your own [Asterisk](https://www.asterisk.org) or [FreePBX](https://www.freepbx.org)**, over ARI (the
Asterisk REST Interface and its event WebSocket). A scene calls a phone and plays it a message; an incoming call
starts a scene. The integration never speaks SIP or RTP itself: Asterisk does, with your operator trunk and your
phones.

> **Developed without the hardware: feedback welcome.** Tested end to end against Asterisk 23.5 in Docker, with
> simulated phones (Local channels that answer, press 1, stay silent, ring out or are busy), not with a real
> operator line. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-sip/issues).

## Features

- **Scene action "Call and play a message"**: calls a number of the allow-list, plays recorded Asterisk sounds
  (`custom/alarm`, `digits:1234`…) up to 5 times, retries up to 10 times with a delay, and can wait for **1** to be
  pressed (DTMF) to acknowledge an alarm. It returns at once; the outcome comes back through a trigger.
- **Scene action "Stop the calls"**: hangs up and cancels the retries, for one number or for all.
- **Trigger "Incoming call"**: for every call the dialplan sends to `Stasis(gladys)`, filtered by caller number and
  number called, with the caller's number and name as variables. The call then goes on in the dialplan (the phones
  ring) or is hung up without being answered.
- **Trigger "Outgoing call ended"**: number, result (acknowledged, answered, no answer, busy, failed, cancelled)
  and number of attempts.
- **Asterisk server device**: server reachable, last incoming call, last outgoing call.
- **Dashboard widget "Phone calls"**: link to Asterisk, calls in progress, last calls, a button to stop the calls.
- Texts in English, French, German and Spanish.

## Requirements

- Gladys Assistant 5.1 or newer.
- Asterisk 16 or newer (tested with 23.5), or FreePBX, with the HTTP server and an ARI user enabled. Gladys must
  reach its HTTP port (8088 by default).
- Messages recorded as Asterisk sounds: Asterisk has no built-in text-to-speech the integration could rely on.

The full set-up, Asterisk and FreePBX, is in the documentation: [English](docs/en.md), [français](docs/fr.md),
[Deutsch](docs/de.md), [español](docs/es.md).

## Installation

In Gladys: **Integrations → Install from GitHub**, then enter `https://github.com/guim31/gladys-sip`. Fill in the
ARI address, user and password, the allowed numbers and the dial string, then press **Test the connection**.

## Limits

- No text-to-speech: messages are recorded sounds.
- Only the allowed numbers can be called; premium-rate numbers must never be added.
- The caller number can be spoofed: it must not be the only lock of a door or an alarm.
- Calls in progress when the integration or Asterisk restarts end as failed.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests replay ARI events captured from Asterisk 23.5 (`test/fixtures/ari-events.json`) against the SDK's fake
Gladys; they never touch the network.

## Credits

- [Asterisk](https://www.asterisk.org) and its ARI documentation (Sangoma Technologies, GPL-2.0).
- Built from the official
  [JavaScript integration template](https://github.com/GladysAssistant/integration-template-js) and the
  [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js).

This project is not affiliated with, endorsed or sponsored by Sangoma Technologies, the Asterisk project or
FreePBX. Asterisk and FreePBX are trademarks of Sangoma Technologies.

## License

[Apache-2.0](LICENSE)
