# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- "Call and play a message" scene action: calls an allowed number through your Asterisk or FreePBX (ARI), plays
  recorded sounds one or several times, calls again when nobody answers, and can wait for 1 to be pressed to
  acknowledge an alarm.
- "Stop the calls" scene action, for one number or for all.
- "Incoming call" trigger (caller number and name, number called) and "Outgoing call ended" trigger (number,
  result, attempts).
- Asterisk server device: server reachable, last incoming call, last outgoing call.
- "Phone calls" dashboard widget, with a button to stop the calls in progress.
- "Test the connection" and "Test call" buttons in the configuration.
- Documentation in English, French, German and Spanish, with the Asterisk and FreePBX set-up.
