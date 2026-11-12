# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration holds: the ARI address, user and password of your Asterisk server, stored by Gladys in the
integration configuration (nothing is written under `/data`). The password travels in the ARI requests (HTTP Basic)
and in the address of the ARI event WebSocket (`api_key`): use ARI over your local network only, or behind TLS
(`https://`), and never log that address. The integration places calls only to the numbers of its allow-list, and
plays only Asterisk media (no URL).

Network: it only opens connections to the configured ARI address; it publishes no port.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Asterisk, FreePBX, and the phone operators they call through.
