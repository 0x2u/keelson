# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-12

First public version. Keelson is pre-1.0: expect rough edges (see [limitations](docs/limitations.md)).

### Agent
- One agent per server. It connects out to the dashboard (no inbound port), or you pair it with a one-time code, over SSH, or by file.
- Blue/green deployments with a health gate, drain, soak and automatic return to the previous version. Release steps, including a verified encrypted backup. Rollback and promotion of the exact image.
- Builds on the server, or on another server or a connected computer, with presets for Next.js, Node.js, Vite and static sites. No registry needed.
- GitHub integration: push and pull-request builds, signed webhooks, commit statuses, pull-request previews. A GitHub Action for CI-driven deploys.
- PostgreSQL: declared or managed databases, scheduled `pg_dump` backups with read-back checks, age encryption, local and S3 destinations, retention, guided restore, restore tests.
- Scheduled jobs (HTTP call, host program, one-off container) with overlap protection, history and failure alerts.
- Reverse proxy through Caddy or nginx, with drift detection.
- Notifications to Telegram, a webhook and a heartbeat URL. The last 200 are kept with their delivery status.
- Host load, memory and disk, and container CPU and memory, recorded every 30 seconds for 24 hours (`GET /v1/stats/host`, `GET /v1/stats/history`). App uptime and incidents kept for 30 days (`GET /v1/apps/{app}/availability`).
- Scoped, expiring API tokens, a REST API and an MCP server.
- **`keelson-agent config validate`** checks the apps file and its project files offline, as the agent loads them, with the file and line of each problem (`--format text|json|github`, `--strict` to fail on warnings; exit 0 valid, 1 invalid, 2 usage or an unreadable file). JSON Schemas of the apps file and of the project files, generated from the agent's own structs with each key's documentation as hover text, are in `docs/json-schema/` for completion in an editor ([Configuration](docs/reference/configuration.md#checking-a-file-and-editing-it-with-completion)). CI fails when they are stale, when an example of the documentation does not pass `config validate --strict` and the schema, or when a wrong file passes either.
- **`keelson-agent doctor`** checks a server before or after an install, with a fix for each finding: the Docker engine, the configuration, the files it names (missing, unreadable, a secret readable by every account), the data directory and whether `agent.db` was written by a newer agent, the disks of the data directory and of Docker, Caddy's admin API, notifications and the way to the dashboard for a server that connects out. Exit 1 when something failed.
- **Prometheus metrics**: `GET /metrics` on the agent, in the text exposition format and behind the same token (and client certificate) as the other reads: the engine and the host, and for each app whether it is up, its restarts, its last deployment, and for each job and backup when it last ran and succeeded, plus the proofs the agent has seen (a restore tried, a key proven). A part that cannot be read leaves its series out and says so in `keelson_collector_success`. `docs/examples/prometheus` has a scrape configuration and alert rules with unit tests; CI lints a real agent's answer and tests the rules with `promtool` ([Metrics](docs/reference/metrics.md)).

### Dashboard
- First-run setup, projects and environments, forms and a YAML editor with validation, diff, versions and restore, an audit log, a readiness checklist, and a domains wizard with Cloudflare DNS.
- New projects from an image (no GitHub needed) or from a repository.
- Charts for resources over time, per-app availability, CPU and memory, a deployment summary, alert history in Activity, and memory and load in the server list.
- Two-factor authentication, passkeys, step-up unlock, sessions and an IP allowlist. Secrets are write-only.
- Settings, About shows the latest release and the command to update. The dashboard asks api.github.com for it once a day and sends nothing about your servers; set `KEELSON_UPDATE_CHECK=off` to turn it off.
- The Update page of a connected server shows whether the update worked.
- **A visual identity.** The Keelson mark (two frames of a hull over the keel) and its name in the sidebar, on the sign-in and setup pages, as the favicon and the app icon; a palette built on the mark's cyan and ink in both themes (the dark theme's primary action, focus ring and active tab are the brand cyan; every text pair still passes WCAG AA); Sora for the name and page titles, served from the repository. The logo files, colours and rules are in [`docs/brand`](docs/brand/README.md).
- **A layout of its own.** Home opens with the state of the fleet said once and large (an orb, the headline, apps up, deployments and backups) and the last 24 hours as 24 hourly bars, computed from the same data as the lists below; server tiles show disk, memory and load as gauges that stay neutral until a measure needs a look; the pipeline of a deployment is a connected rail; project cards have a state hairline and an environment rail; section titles, table headers and summary cards read as instrument labels in the display face; the active tab and sidebar item take the brand. The main area can now shrink, so a wide table scrolls inside its card instead of pushing the page sideways.

### Install
- One-command dashboard install (`deploy/install.sh`, compose, Caddy). Re-running it with `--version vX` updates an existing install: it keeps `.env`, the data volume and the master key, and copies the database to `<dir>/backups` first.
- Multi-architecture release images and agent binaries, built by the release workflow (with a dry-run mode).
- A failed agent upgrade is rolled back, including the agent database.

### Testing and CI
- CI runs the agent tests and the real-engine tests on amd64 and arm64 runners. New real-engine tests break a deployment on purpose: a release that exits at once never takes the site down, and an agent killed in the middle of the swap (old container renamed and no new one yet; new container started and not yet judged) comes back on the previous version and closes the deployment as rolled back. A frozen `agent.db` written by v0.1.0 must open, migrate and keep its history in every later version.
- `scripts/demo-rollback.sh`: a deployment that fails, on your machine with only Docker and Go: version 2 of a site cannot start, the agent puts version 1 back and the script checks that it serves again. It runs in CI on both architectures.

### Security
- The agent is built with Go 1.27.4, which fixes GO-2026-6859 (CVE-2026-97054) in `net/http`: an HTTP/1 server using `MaxBytesReader` could crash when its handler read the request body while writing the response header. The agent's enrolment route is one such handler. CI's `govulncheck` caught it; `agent/go.mod` now requires the fixed version.

### Documentation
- Hosting, architecture, a reference for the agent, examples, a migration guide, upgrade and restore procedures, and development notes.

[Unreleased]: https://github.com/0x2u/keelson/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0x2u/keelson/releases/tag/v0.1.0
