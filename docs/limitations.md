# Limitations

Keelson is pre-1.0 and has one maintainer. This page lists what it does not do, what has not been tested on real servers, and the rough edges that are known.

## What Keelson does not do

- It manages Docker hosts only. There is no Kubernetes or Swarm support, and one agent manages one Docker host.
- There is no catalogue of one-click applications, and Docker Compose files are not accepted as input.
- There is one operator. No accounts or roles.
- PostgreSQL is the only supported database engine.
- Build presets exist for Next.js, Node.js, Vite and static sites. Any other stack needs a Dockerfile.
- Business notifications (a new order, a new review) are the application's job, not Keelson's.

## What has been tested

The agent and its installer were run on Debian 12 and 13, and the connected install on arm64. The agent, the dashboard and the MCP server have automated tests, including tests against a real Docker engine.

Not tested on real servers:

- Other Linux distributions. SELinux-enforcing hosts, rootless Docker and podman are not supported.
- amd64 hosts. The agent and its real-engine tests run on amd64 machines in CI, but the binaries have not been run on a real amd64 server.
- SSH login with a password, and `sudo` that asks for a password.
- Uninstall on a host where nginx references the upstreams file, or where ufw is active.
- A hardware passkey.
- Access through a private network or a Cloudflare Tunnel.
- A GitHub webhook delivery from a real pull request, end to end.

## Certificates and DNS

- A Let's Encrypt certificate was issued once, on one server (HTTP-01 behind Cloudflare). Renewal, including after a reboot, and the dashboard installer's own ACME setup have not been checked. Other runs used Caddy's internal CA.
- There is no certificate-expiry alert. The domain HTTPS check warns when you run it and the certificate has 14 days or less left. The agent's CA and client certificates last 5 years and are not renewed automatically.
- Cloudflare behaviour (account-scoped tokens, rate limits, propagation, IPv6) comes from Cloudflare's documentation, not from tests.

## GitHub

- The dashboard talks to github.com only. GitHub Enterprise Server, SAML-protected organisations and fine-grained tokens limited to one repository have not been tried.
- A webhook that arrives while the same app is deploying is refused with `409` and is not retried. There is no deployment queue.
- A dashboard restart during a build leaves the commit status at `pending`.
- A run that finishes after its pull request was closed is only skipped when a GitHub token is connected.
- Previews work with Caddy only. They do not appear in `GET /v1/apps`, they get no database of their own, and running more than a few at once has not been tested.

## Builds

- Only the engine's classic builder is used, so BuildKit features (`RUN --mount`, `# syntax=`) are not available. `platform` builds are the exception: they use `docker build --platform`, without memory or CPU limits.
- There are no build secrets, only plain build arguments and write-only build variables.
- The build cache is never pruned.
- A build with `network: host` runs repository code in the host network namespace. Enable it only for repositories you trust.
- A large Next.js build can need several GiB. Set `build.memory` from a measurement, not from the default.
- Presets have no pre-build step, do not detect Nuxt, SvelteKit, Remix or Astro, and only read the root of a monorepo.

## Deployments

- A rollback restores the image, not the database schema. A migration that fails halfway is not undone, which is why the pre-migration backup step exists.
- Metric gates ask the instant query API of a Prometheus-compatible server, once per interval, with no credentials (put a local proxy in front for one that needs them). They judge numbers, not traffic: there is no canary that sends a share of requests to the new version, so the metric is only as good as your labels at telling the new container from the old one. The gate against a real Prometheus is tested; Mimir, VictoriaMetrics and Thanos are assumed to answer the same API and have not been tried.
- Tabs that stay open across a switch do not get the previous version's static assets. A container's logs go away with the container at each switch.
- A deployment of an image without a `HEALTHCHECK` waits the `stable_after` delay (about 10 s) at the Switch step. When a container reports unhealthy, the healthcheck's own output is not included.
- The agent's schema upgrade only goes forward. `agent.db` is copied first, and an older agent refuses a newer schema.

## Databases and backups

- Only PostgreSQL (16 is the version tested).
- S3 is tested against MinIO, not against AWS, R2, Scaleway or Backblaze. An upload above 5 GiB is refused (no multipart upload).
- Roles and their grants are not part of a dump. A restore over a live database drops table grants and holds locks while it runs.
- The restore proof compares row counts, not content. A dump that needs roles or extensions the target does not have is not checked.
- Managed PostgreSQL runs one instance per server, has no automatic major upgrade, has a memory cap but no CPU cap, and writes backups to the same disk by default. Point them at S3.
- Backups do not cover application volumes, host-mounted data, `/etc/keelson`, the dashboard's data (apart from a manual download) or `agent.db` (beyond its daily copies).
- A failed backup caused by a permission problem on the data directory names the path but not the cause.

## Alerts and monitoring

- The agent keeps the last 200 notifications with their delivery status, but an undelivered one is not retried after a restart. An event raised while the agent is down, or queued when it is killed, is lost. The agent cannot report its own death: use the heartbeat.
- There is no alert for proxy drift, and none when the dashboard cannot reach an agent.
- A job that failed before any notification channel existed is not announced when a channel is added later. A new failure does alert.
- The Telegram API has not been exercised in tests. The secret files of a channel must already exist on each agent.
- Host and container statistics are kept for 24 hours and uptime for 30 days by the agent; longer history and trends are for a Prometheus scraping `/metrics` ([Metrics](reference/metrics.md)), which has no per-container CPU and memory and no histograms. There is no trend or time-to-full for the disk in the dashboard.
- The dashboard colours resource usage at fixed 85 and 95 percent. The agent alerts at the configured `disk_alert_percent` and `memory_alert_percent`.

## Security and API

- The audit trail is not shipped off the server. There is no command to revoke everything or to rotate credentials.
- API tokens have two scopes. A `deploy` token can deploy any app on its servers, with no per-app limit. No token can change configuration, variables or restores.
- An app on the host network may listen on all interfaces and bypass a CDN unless the firewall closes the ports.
- A full disk makes signed requests fail with `507`.

## Interface

- Several settings exist only as YAML or an environment variable: the previews template, static sites and certificates of the Caddy proxy, the nginx proxy block, the IP allowlist (`KEELSON_ALLOWED_IPS`, which also applies to agents that connect out), and the secret files for Telegram, webhooks and S3 backups, which you create on the server.

- The phone layout (390 px) is checked on the main pages only. Some tables scroll sideways.
- Updating or uninstalling the agent of a connected server is a command you run on the server, not a button.
- Configuration versions are mostly saved without a comment.
- The first load of a server's overview after the dashboard has been idle can take two or three seconds.
