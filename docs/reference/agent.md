# The agent

The agent is a single static Go binary, `keelson-agent`, that runs on every managed server. It talks to the local Docker engine and keeps its own configuration. It deploys, health-gates and rolls back, runs scheduled jobs and backups, and sends its own alerts. It does not need the dashboard to do any of this.

## Commands

| Command | Purpose |
|---|---|
| `keelson-agent serve [flags]` | Run the HTTP API. Read-only unless `--apps` is set; `--relay-file` also dials out to a dashboard (see [Agents that connect out](./relay.md)). |
| `keelson-agent connect [CONNECTION-STRING]` | Connect a computer to a dashboard as a build machine; no port is opened ([relay](./relay.md)). |
| `keelson-agent ps [-a]`, `logs [-f] [-n N] NAME`, `stats NAME` | Local CLI over the Docker engine; no token needed. |
| `keelson-agent deploy --apps FILE APP TAG\|sha256:DIGEST` | Deploy an image to an app, locally. Refuses to run beside a serving agent ([Deployments](./deployments.md)). |
| `keelson-agent history [-n N] [APP]` | Recent deployments. |
| `keelson-agent notify-test --apps FILE` | Send a test message on every notification channel ([Notifications](./notifications.md)). |
| `keelson-agent doctor [--apps FILE] [--data-dir DIR] [--relay-file FILE]` | Look at this machine the way the agent will find it: the Docker engine, the configuration, every file it names (missing, unreadable, a secret readable by all), the data directory and the database schema, the disks, Caddy's admin API and, for a server that connects out, the dashboard. `ok`, `WARN` or `FAIL` for each, with what to do; exit 1 when something failed. It changes nothing and needs no running agent. |
| `keelson-agent config validate\|split\|dump\|migrate` | Check the files offline, per-project files, a dump of what the configuration makes the agent run, and the schema migration ([Configuration](./configuration.md#checking-a-file-and-editing-it-with-completion), [Schema](../schema.md)). |
| `keelson-agent install`, `enroll-code`, `uninstall` | Set the agent up on a server, pair it with a dashboard, remove it ([Servers](./servers.md)). |
| `keelson-agent version` | Print the version. |

`keelson-agent COMMAND -h` lists the flags of a command.

## Running it

```bash
openssl rand -hex 32 > token && chmod 600 token
keelson-agent serve --token-file token            # listens on 127.0.0.1:7070, read-only
curl -H "Authorization: Bearer $(cat token)" http://127.0.0.1:7070/v1/containers
```

On a real server, `keelson-agent install` does all of this ([Servers](./servers.md)). To build the binary from source, see [Development](../development.md).

`serve` flags can also be set through `KEELSON_LISTEN`, `KEELSON_TOKEN_FILE` (or `KEELSON_TOKEN`), `KEELSON_DOCKER_SOCKET`, `KEELSON_TLS_CERT`, `KEELSON_TLS_KEY`, `KEELSON_TLS_CLIENT_CA`, `KEELSON_APPS`, `KEELSON_PROJECTS_DIR`, `KEELSON_DATA_DIR`, `KEELSON_ENROLL_DIR`, `KEELSON_RELAY_FILE` and `KEELSON_DEPLOY_SECRET_FILE` (or `KEELSON_DEPLOY_SECRET`).

Defaults that limit what the agent accepts:

- The API token must be at least 32 characters.
- Plain HTTP is refused on a non-loopback address unless you pass `--allow-insecure-http`.
- `--tls-client-ca` turns on mutual TLS (TLS 1.3 only).
- Without `--apps` the agent is read-only: the engine client only issues `GET` requests and the API has no mutating routes.

To enable deployments, jobs, databases and the rest, point `serve` at an apps file with `--apps`. See [Configuration](./configuration.md) and [Deployments](./deployments.md). API authentication (read token, signed requests) is in [API](./api.md).

## Read-only routes

| Route | Description |
|---|---|
| `GET /v1/health` | Public. `200` when the Docker engine answers, `503` otherwise. |
| `GET /v1/info` | Agent version and read-only flag. |
| `GET /v1/containers?all=` | List containers (running only unless `all=true`). |
| `GET /v1/containers/{id}` | Container detail and health. The environment is never returned. |
| `GET /v1/containers/{id}/logs?follow=&tail=&since=` | Server-Sent Events (`log`, then `end` or `error`). `tail` is a line count or `all` (default 100); `since` is a unix time, an RFC 3339 time or a duration such as `10m`. |
| `GET /v1/containers/{id}/stats?stream=` | Server-Sent Events of CPU, memory, network and PID samples, or one JSON sample with `stream=false`. |
| `GET /v1/system` | The machine and the engine: load, memory, uptime, the disk holding the engine's data (`/` when the agent cannot read that directory), Docker version and counts. `os` and `arch` (`linux`, `amd64` or `arm64`) are the **engine's** platform, which is what an image must be built for to run on it (on Docker Desktop, that is the VM's, not the Mac's). They are left out when the engine does not say. A part the host does not expose is left out (a Mac has no `/proc`, so its load, memory and uptime are absent). A broken engine is reported as `engine_error` beside the host's numbers. |
| `GET /v1/system/disk` | The engine's disk accounting (`docker system df`): images, containers' writable layers, volumes and build cache, the unused images and what removing them frees. It is slow on a busy host, so one answer is shared for 30 s. |
| `POST /v1/enroll` | Public (no token, no client certificate), only when enrolment is on: `{"code": "..."}` returns the credentials for a one-time enrolment code (see [Enrolling the dashboard with a one-time code](./servers.md#enrolling-the-dashboard-with-a-one-time-code)). |

At most 32 log, stats and event streams run at the same time; more get `429`. Every route of the API is listed in [API](./api.md).

## Operational notes

- The listener has a ten-second TLS handshake deadline and a cap of 256 connections, so idle sockets cannot starve the API.
- On a full disk a signed request answers `507`. The replay table is written before anything runs, so every deploy, rollback and edit fails there. Free space on the server and retry.
- The systemd unit has `TimeoutStopSec=180` because the agent's own drain can take about 150 seconds.
- The agent keeps its state in `--data-dir` (`/var/lib/keelson` by default): `agent.db` (deployment history, what serves, previews, replay protection, stats), stored variables, backups and staging directories. [Deployments](./deployments.md#disk-housekeeping) describes the copies it makes of its own database.
