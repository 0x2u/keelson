# Agents that connect out

A server or a computer can reach the dashboard instead of the other way round. The agent opens one outbound HTTPS connection to the dashboard and keeps it open. The dashboard sends down that connection the requests it would send to a reachable agent (same paths, same bearer token and HMAC signature, same answers), and the agent hands them to its own handler in process. Nothing listens on the machine: no port, no TLS certificate, no firewall rule, no SSH login. It works behind NAT.

There are two forms:

- A server (`keelson-agent install --dashboard URL --code CODE`, run through the one-command install). It is a systemd service that serves apps, builds, or both.
- A computer (`keelson-agent connect`). It is the same agent in the foreground, without systemd, for a Mac or a laptop that builds images for your servers.

For the direct form, where the dashboard reaches the agent, see [Installing and connecting servers](./servers.md). The dashboard side of the relay (reverse proxy settings, `KEELSON_PUBLIC_URL`) is in [Hosting](../hosting.md#reaching-the-agents).

## Connecting a server with one command

*Servers → Add server → Connect with one command* makes a code (single use, 30 minutes) and shows `curl -fsSL https://<dashboard>/install | sudo sh -s -- --code <code> [--name NAME]`. Run it as a sudo user on a Linux server (systemd, amd64 or arm64) that has Docker. The script is public and carries no secret. It downloads the dashboard's own agent binary by code, checks it runs, and calls `keelson-agent install --dashboard <url> --code <code>`, which:

1. Registers with the dashboard first (`POST /api/relay/enrol` with `"serves": true`). A refused code or an unreachable dashboard leaves nothing on the server, and a server without Docker is refused **before** the code is spent.
2. Creates the `keelson` account, `/etc/keelson/{token,deploy-secret,relay.json}` (`root:keelson`, `0640`) and `config/apps.yaml`, and installs a systemd unit running `serve --relay-file /etc/keelson/relay.json --listen=`. The agent makes its own token and deploy secret and gives them to the dashboard once. `relay.json` holds the credential that proves the server to the dashboard.
3. Starts it and waits until it stays up. It prints a short JSON (`name`, `server_id`, `dashboard`, `agent_version`) and no secret.

The result is the same agent as a directly reached server (apps, jobs, databases, previews, proxy, configuration editing). Only the transport differs. The server reconnects by itself (backoff, see the connect command below). When the dashboard no longer knows its credential (the server was deleted there), the agent exits with status 78 and stays stopped (`RestartPreventExitStatus=78`). Run `sudo keelson-agent uninstall` and then use a new code to connect it again. Unlike a laptop build machine, a connected server that is off for more than a few seconds is an incident (*Unreachable*).

- **Upgrade.** The server's *Update* page shows `curl … | sudo sh -s -- --upgrade --code <fresh code>` (here the code only downloads the binary). `keelson-agent install --upgrade` keeps how the server was set up (it detects `relay.json`) and keeps the secrets without printing them.
- **Uninstall.** `sudo keelson-agent uninstall [--purge]` removes `relay.json` with the rest, and the apps keep running. Delete the server in the dashboard too.
- **Receiving an image.** A connected server receives an image built on another machine like any server. The archive is sent as a streamed request body (see [below](#a-request-body-over-the-relay)). A build on one agent followed by a healthy deployment on another that only connects out has been run end to end.
- **On a Mac or any machine without systemd**, the same command runs the foreground build-machine mode ([`connect`](#a-computer-that-connects-out-keelson-agent-connect)), without sudo.

## A computer that connects out: `keelson-agent connect`

```bash
keelson-agent connect [--dir DIR] [--name NAME] [--docker-socket PATH] [CONNECTION-STRING]
```

Use this for a computer the dashboard cannot reach (a Mac, a laptop, a PC behind a router). It runs the same agent as `serve` (deployer, builder, jobs, configuration manager, the whole API) with no listener at all: no port, no TLS, no enrolment endpoint. The dashboard shows the command to run (*Servers → Add server → A computer that connects*): `curl -fsSL "<dashboard>/api/relay/binary?os=…&arch=…&code=…" -o keelson-agent && chmod +x keelson-agent && ./keelson-agent connect ksr1.…`. The binary comes from the dashboard, by code, so no browser session is needed and macOS does not quarantine it. `scripts/build-agent.sh` builds it for `linux` and `darwin` on `amd64` and `arm64`.

- **First run, with a connection string** (`ksr1.` and the base64url of `{"u": <dashboard URL>, "c": <code>}`). The agent makes its own API token and deploy secret (32 random bytes each, from `crypto/rand`), sends them once with the code to `POST /api/relay/enrol` and writes its files. The code works once, for 30 minutes. `--name` is the name the dashboard shows (default: the host name, with anything a server name may not contain replaced by `-`; the dashboard adds a number when the name is taken).
- **Next runs, without one.** It reads `relay.json` and reconnects. With a connection string **and** a `relay.json` it refuses and tells you to delete the directory first, because enrolling twice would leave a second machine in the dashboard and orphan the first.
- **Files**, in `--dir` (default `$HOME/.keelson`), all `0600` and the directories `0700`:
  - `token` and `deploy-secret`: the agent's own, also held, encrypted, by the dashboard.
  - `relay.json`: `{"dashboard", "credential", "server_id", "name"}`. The credential proves "this is machine X" to the dashboard, which stores only its SHA-256.
  - `apps.yaml`: starts as `apps: []` and is edited by the dashboard through the configuration API, like any agent's.
  - `data/`: the agent's database, stored variables and image staging.

  The credential is never printed. Removing the machine in the dashboard revokes it, and the agent then stops and says so.
- **Foreground** until Ctrl-C or SIGTERM. It reports on standard error: `connected to https://… as marc-mac`, `disconnected (…), retrying in 4s`. It reconnects by itself (1 s, doubling to 30 s, ±20 % jitter, starting over after a connection that lasted a minute) and treats 45 s without a line from the dashboard (it pings every 15 s) as a dead connection. It stops without retrying when the dashboard does not know the credential (`401`), and when another process connected with the same credential and took its place (two would replace each other forever).
- **Docker.** `--docker-socket`, else `$DOCKER_HOST` when it is `unix://…`, else `/var/run/docker.sock`, else Docker Desktop's `$HOME/.docker/run/docker.sock`. With none of them it still starts (Docker may start later) and says where it looked. The same fallback applies to the other commands, but only when `/var/run/docker.sock` does not exist, so `serve` on a Linux server behaves as before.

**At login.** The agent does not install itself as a service. Put the binary somewhere stable and let the system start `connect` with no string (it was enrolled once). On a Mac, use `~/Library/LaunchAgents/dev.keelson.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.keelson.agent</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/keelson-agent</string><string>connect</string></array>
  <key>RunAtLoad</key><true/>
  <!-- restart after a crash, not after a deliberate stop: a machine that was removed or replaced exits with an error and must stay down -->
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>StandardErrorPath</key><string>/Users/you/.keelson/agent.log</string>
</dict>
</plist>
```

`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.keelson.agent.plist` starts it, and `launchctl bootout gui/$(id -u)/dev.keelson.agent` stops it. On Linux, use `~/.config/systemd/user/keelson-agent.service`:

```ini
[Unit]
Description=Keelson build machine
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/bin/keelson-agent connect
# on-abnormal, not on-failure: a removed or replaced machine exits with an error and must stay down
Restart=on-abnormal
RestartSec=5
# Environment=DOCKER_HOST=unix:///run/user/1000/docker.sock   # rootless Docker

[Install]
WantedBy=default.target
```

Start it with `systemctl --user enable --now keelson-agent`. `loginctl enable-linger $USER` makes it start at boot without a login. Docker Desktop must be running for builds; the agent does not start it.

**What a connected machine can do.** It is a build machine: a server with nothing to serve. It builds images for requests (`POST /v1/builds`, see [Builds](./builds.md#building-on-one-server-running-on-another)) and exports them (`POST /v1/images/export`), and the dashboard moves the image to the server that runs it. It is never a deploy target, because nothing can reach what it runs, so the dashboard does not offer it where you choose a server to *run* something. At most 64 requests are handled at once (the dashboard sends no more; a 65th is answered `429`). An answer is sent in chunks of at most 1 MiB, and the next chunk only after the dashboard took the previous one.

**Building for the server's architecture.** Docker Desktop on an Apple-silicon Mac builds `linux/arm64` by default, while servers are mostly `linux/amd64`. The dashboard sets `build.platform` in the request from the target's architecture, and you can set it on the app to force one. A `RUN` step then runs under emulation (Rosetta or QEMU in Docker Desktop). The receiving server refuses an image for the wrong architecture on import (see `platform` in [Builds](./builds.md#building-on-one-server-running-on-another)).

**Reaching something on the computer from a build.** Build containers run in Docker Desktop's Linux VM, not on the Mac. From a build, `host.docker.internal` is the Mac. For example, an SSH tunnel opened on the Mac with `ssh -N -L 5432:db.internal:5432 you@server` is `host.docker.internal:5432` from a build. For the same reason **`build.network: host` means the VM's network, not the Mac's**: `127.0.0.1` in a build is the VM and reaches nothing running on the Mac, so use `host.docker.internal`. On a Linux computer with a native engine, `host` is the computer's own network as on any server.

- **Build on.** On an app's *Source → Build on* a connected machine is a card like any server, and nothing is created on it. It needs a `build_limits` section only to set ceilings. The card shows the machine's `os/arch` and warns when it differs from the server's and the app sets no `build.platform`. The card of an offline machine is disabled. Only the request's `build.args` are used.
- **Security.** The connection is outbound only, so no port is opened on the computer. The code works once. The machine then holds a credential (the dashboard stores only its SHA-256) that proves "this is machine X" and nothing else. Requests are the same signed requests a directly reachable agent gets (bearer token and HMAC). An attacker who has only the credential can answer as that machine, but cannot read other machines' traffic or send it anything.

## A request body over the relay

A request to a server that connects out normally travels in the connection's NDJSON line (1 MiB at most). An image archive does not fit, so the request line says `"stream": true` and the agent fetches the body itself with `GET /api/relay/request/<id>/body` (its credential as bearer; one time, `409` after; cancelled with the request). The body is never held whole (a 1.2 GiB push moved the dashboard's memory by 4 MiB). An agent announces the capability with `X-Relay-Features: request-stream` when it connects. Sending an image to one that does not announce it fails with a message to update the agent on that server.
