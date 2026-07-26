# Security policy

## Supported versions

Security fixes are applied to the latest published PortPatch release. Older portable binaries and AppImages should be replaced rather than retained.

## Reporting a vulnerability

Do not publish technical details for a suspected vulnerability involving credential disclosure, host-key verification, unintended listener exposure, or release integrity. Use GitHub's private vulnerability reporting feature when it is available. Otherwise, open a minimal issue requesting a private contact channel without including reproduction details.

Include the affected version, operating system, reproduction steps, expected impact, and any relevant logs with secrets removed. Do not include passwords, private keys, passphrases, or production server addresses.

## Security boundaries

- PortPatch forwards TCP streams; it does not inspect or authenticate the application protocol carried through a TCP route.
- SOCKS5 listeners do not currently provide client authentication. Keep them on loopback unless the surrounding network supplies an appropriate access-control boundary.
- A remote SSH server can change the effective exposure of remote listeners through its `GatewayPorts` policy.
- Linux credential protection depends on an available Secret Service or KWallet backend.
- The current AppImage packaging has a documented Chromium sandbox limitation. See `docs/architecture.md`.

Release checksums detect corruption. Build provenance can be verified with GitHub CLI as described in `docs/releasing.md`. Windows executables are currently not Authenticode-signed and may show an unknown-publisher warning.
