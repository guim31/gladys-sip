# SIP voice calls (Asterisk)

Call a phone from a Gladys scene and play it a message (alarm, water leak, door left open), and react to incoming
calls (open the gate when a known number calls). The integration drives **your own Asterisk or FreePBX** through
ARI, the Asterisk REST Interface: it never speaks SIP itself, your phone server does.

Developed without a phone operator line: tested against Asterisk 23.5 in Docker, with simulated phones. Feedback
welcome.

## What you get

- A **"Call and play a message"** scene action: calls an allowed number, plays the message once or several times,
  calls again if nobody answers. Optionally, the call is only **acknowledged** when someone presses **1**: until
  then, the integration keeps calling (up to the number of attempts).
- A **"Stop the calls"** scene action: hangs up and cancels the retries (the alarm was a false one).
- An **"Incoming call"** trigger, filtered by caller number and number called, with the caller's number and name
  as variables.
- An **"Outgoing call ended"** trigger, filtered by number and result (acknowledged, answered, no answer, busy,
  failed, cancelled).
- An **Asterisk server** device: server reachable, last incoming call, last outgoing call.
- A **Phone calls** dashboard widget.

## Prerequisites: Asterisk

1. Enable the HTTP server in `/etc/asterisk/http.conf`:

   ```ini
   [general]
   enabled=yes
   bindaddr=0.0.0.0
   bindport=8088
   ```

2. Create an ARI user in `/etc/asterisk/ari.conf` (choose a long password):

   ```ini
   [general]
   enabled=yes

   [gladys]
   type=user
   read_only=no
   password=a-long-random-password
   ```

3. Record your messages. A message is one or more Asterisk sounds: put `alarm.wav` (8 kHz mono) in
   `/var/lib/asterisk/sounds/en/custom/` and use `custom/alarm`. The `digits:1234`, `number:42` and `tone:ring`
   media work too.
4. For incoming calls, send the calls to the integration from the context of your operator trunk in
   `extensions.conf`, before ringing your phones:

   ```ini
   [from-trunk]
   exten => _X.,1,Stasis(gladys)
    same => n,Dial(PJSIP/100,30)
   ```

   When the integration is stopped, `Stasis()` fails at once and the call goes on: your phones still ring.

5. Outgoing calls use your operator trunk: the dial string `PJSIP/{number}@my-trunk` calls through the PJSIP
   endpoint `my-trunk`. Run `core reload` after these changes.

## Prerequisites: FreePBX

1. **Settings → Asterisk REST Interface Users**: add a user (read/write), and note its password. Check in **Settings →
   Advanced Settings** that the Asterisk built-in mini-HTTP server is enabled (port 8088).
2. **Admin → System Recordings**: record or upload the messages; a recording named `alarm` is the sound
   `custom/alarm`.
3. Dial string: `Local/{number}@from-internal`, so that the outbound routes of FreePBX choose the trunk.
4. Incoming calls: in `extensions_custom.conf`, add a context that goes through Stasis then to your inbound
   route, and point a **Custom Destination** or the trunk context to it:

   ```ini
   [gladys-incoming]
   exten => _X.,1,Stasis(gladys)
    same => n,Goto(from-trunk,${EXTEN},1)
   ```

## Configuration

| Field              | Use                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------- |
| ARI address        | `http://<server address>:8088`                                                            |
| ARI user, password | The user of `ari.conf` or of FreePBX                                                      |
| Stasis application | `gladys` by default: the name used in `Stasis(gladys)`                                    |
| Allowed numbers    | The only numbers scenes may call, separated by commas                                     |
| Dial string        | `{number}` is replaced by the number called                                               |
| Caller ID          | Shown on the phone called, e.g. `Gladys <100>` (the operator may replace it)              |
| Incoming calls     | Continue in the dialplan (the phones ring) or hang up without answering (free for caller) |
| Language           | Language of the feature names and of the call results                                     |

**Test the connection** checks the address and the user. **Test call** places one call (one attempt, one play).

## Scenes

- **Alarm by phone**: trigger "Alarm triggered" → action "Call and play a message", number `0612345678`, message
  `custom/alarm`, 3 plays, 5 attempts, 60 s between attempts, "Wait for 1 to be pressed" checked.
- **False alarm**: trigger "Alarm disarmed" → action "Stop the calls".
- **Gate by phone**: trigger "Incoming call", caller number `0612345678` → open the gate. In "hang up without
  answering" mode, the call costs the caller nothing.
- **Nobody acknowledged**: trigger "Outgoing call ended", result "No answer" → send a message to another person.

The scene action returns at once (a call with retries outlasts what a scene action may take): the result arrives
through the "Outgoing call ended" trigger and the "Last outgoing call" feature. The number must be written as in the
allowed numbers; spaces, dots and dashes are ignored. A second call to a number already being called is not placed.

The caller number of the "Incoming call" trigger is compared as is: type it exactly as the "Last incoming call"
feature shows it (operators often send `+33612345678` or `33612345678`).

## Dashboard

The **Phone calls** widget shows the link to Asterisk, the calls in progress, the time of the last incoming and
outgoing calls and their result, and while a call is in progress, a button to stop the calls (it can be hidden in
the widget settings).

## Limits

- **No text-to-speech**: Asterisk plays recorded sounds. Record your messages once (FreePBX System Recordings, or a
  TTS tool on your computer).
- Only the **allowed numbers** can be called. Never add premium-rate numbers: a scene could call them in a loop.
- The **caller number can be spoofed** by anyone: do not use it alone to unlock a door or disarm an alarm.
- Calls in progress when Asterisk restarts or the link to it drops end as failed; when the integration itself
  restarts, they are lost (no trigger).
- Only the calls routed to `Stasis(gladys)` are seen.
- Developed without the hardware: no real operator line was used in the tests, only Asterisk 23.5 with simulated
  phones. Feedback welcome.

## Troubleshooting

- **"Asterisk does not answer"**: check the address and the port, `http show status` in the Asterisk console, and
  that the Gladys host can reach the port 8088.
- **"Asterisk refuses the ARI user"**: check `ari.conf` (or the FreePBX ARI user) and run `module reload res_ari.so`.
- **"Failed" right away**: the dial string is wrong (`pjsip show endpoints`), or the trunk refuses the call: the
  Asterisk console tells why.
- **The message is silent**: the sound does not exist; check `core show file formats` and the path under
  `sounds/<language>/`.
- **No incoming trigger**: the dialplan does not reach `Stasis(gladys)`, or the application name differs from the
  configuration.
