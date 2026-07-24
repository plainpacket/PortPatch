# PortPatch

PortPatch is a portable desktop application that represents your computer and SSH servers as nodes. Draw a directed edge from the place that accepts a connection to the place that should receive the traffic. Closing the window keeps active routes running in the system tray.

Current version: `0.2.0` - Windows MVP - MIT License

## Features

- A free-form node graph for your computer and multiple SSH servers
- Drag node cards to arrange the map; hold `Ctrl` and drag one node onto another to create a directed route
- Pan the routing map by dragging its background and zoom around the mouse pointer with the wheel
- Parallel routes between the same nodes are separated into distinct curved lanes
- Private keys in `~/.ssh` are detected locally when adding a server
- Local-to-remote, remote-to-local, and remote-to-remote TCP relays
- SOCKS5 routes in either direction
  - Listen on your computer and use a remote server as the egress
  - Listen on a remote server and use your computer as the egress
  - Listen on server A and use server B as the egress
- Private key, password, SSH Agent, and Pageant authentication
- Persistent interface sizing from 80% to 125%
- SHA-256 SSH host-key verification and pinning
- Per-route start and stop controls with exponential-backoff reconnection
- Active connection counts, byte counters, errors, and retry status
- Password and key-passphrase protection through Electron `safeStorage` and Windows DPAPI
- Close to tray, start all, stop all, and quit controls
- Optional launch at Windows sign-in

## Portable distribution

PortPatch is distributed without an installer.

- Windows: one portable `.exe`; run it directly from any folder
- Linux, planned: one AppImage; mark it executable and run it directly
- No administrator access is required for normal use
- Application settings and encrypted credentials remain in the operating system's per-user application-data directory. They are not written beside the executable. This keeps the executable movable and allows it to run from read-only locations.

The Windows executable is currently the only tested distribution. Linux packaging is configured for future development, but Linux releases are not published yet.

### Download for Windows

Download the latest `PortPatch-<version>-windows-x64-portable.exe` from [GitHub Releases](https://github.com/plainpacket/PortPatch/releases). No Node.js, pnpm, installation, or administrator access is required.

`git clone` downloads the source code, not compiled release files. Cloning is intended for contributors who want to build or modify PortPatch.

## Example routes

| Goal | Route |
|---|---|
| Use an LLM on a GPU server at `localhost:8000` from your computer | `My Computer 127.0.0.1:18000 -> GPU Server 127.0.0.1:8000` using TCP |
| Let a remote server use an LLM on your computer at `localhost:8000` | `Server 127.0.0.1:18000 -> My Computer 127.0.0.1:8000` using TCP |
| Browse sites that are reachable only from a server | `My Computer 127.0.0.1:1080 -> Server egress` using SOCKS5 |
| Give an offline server access through your computer's network | `Server 127.0.0.1:1080 -> My Computer egress` using SOCKS5 |
| Connect a port on server A to a service on server B | `Server A bind:port -> Server B host:port` using TCP |

When a server uses a SOCKS5 route, configure the relevant program to use the proxy:

```bash
export ALL_PROXY=socks5h://127.0.0.1:1080
curl https://example.com
```

For a browser, configure `127.0.0.1:1080` as its SOCKS5 proxy and enable proxy-based DNS resolution when available.

## Quick start

1. Download the portable Windows executable from [GitHub Releases](https://github.com/plainpacket/PortPatch/releases) and run it.
2. Select `Add server`, then enter the SSH address, user, and authentication method. For private-key authentication, PortPatch silently selects a recognized key from `~/.ssh`; open `Private key options` only when you need another file or a passphrase. SSH Agent mode uses keys already unlocked in Windows OpenSSH Agent or Pageant.
3. Select `Test connection`, verify the SHA-256 host-key fingerprint, and trust it only if it is correct. PortPatch does not send a password or private key before this confirmation.
4. Hold `Ctrl` and drag the node that should accept connections onto the node that should receive the traffic. Drag without `Ctrl` to rearrange nodes, drag the background to pan, and use the mouse wheel to zoom.
5. Enter the two ports in the compact editor on the new edge. Open `Advanced` only when you need to change addresses, route type, startup, or reconnection behavior.
6. Close the window to keep routes running in the system tray. Use the tray menu to quit completely.

Select the `?` button at any time to review the map controls.

The SSH server must permit the required forwarding through `AllowTcpForwarding`. A restrictive server may return an error such as `administratively prohibited`. Its `GatewayPorts` policy also controls the actual exposure of remotely bound ports.

The default local bind address, `127.0.0.1`, accepts connections only from the same computer. Non-loopback local listeners and every remote-node listener require explicit exposure consent. An SSH server with `GatewayPorts yes` can expose even a requested `127.0.0.1` listener on every interface, so review the server configuration and firewall. The current SOCKS5 listener does not provide user authentication.

## Development

Node.js and pnpm are required.

```powershell
pnpm install
pnpm icons
pnpm test
pnpm start
```

Build the portable Windows executable:

```powershell
pnpm dist:win
```

The output is written to `release/PortPatch-<version>-windows-<arch>-portable.exe`.

The future Linux AppImage must be built and tested on Linux:

```bash
pnpm install
pnpm dist:linux
```

## How it works

Each edge is modeled as two operations instead of an SSH command string:

1. Open a TCP listener on the source node.
2. For each connection, dial the target from the destination node and relay both streams.

When the source is remote, PortPatch uses SSH `forwardIn`. When the target is remote, it uses SSH `forwardOut`. The same model therefore handles conventional local and reverse forwarding as well as server-A-to-server-B routing. See the [architecture document](docs/architecture.md) for details.

## Current limitations

- Only TCP and SOCKS5 CONNECT are supported; UDP is not supported.
- Each server must currently be reachable directly over SSH from the computer running PortPatch. ProxyJump import is planned for a later version.
- PortPatch relays both SSH streams for remote-to-remote routes, so the application must remain running.
- SOCKS5 is a per-application proxy, not a VPN or transparent TUN interface for all server traffic.
- Windows executables are not yet signed with a commercial Authenticode certificate and may trigger a reputation warning.
- Linux code paths and AppImage packaging are prepared but have not been release-tested. Linux autostart integration is also pending.
