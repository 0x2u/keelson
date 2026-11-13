# Documentation

New here? Read the [project README](../README.md), then follow [Getting started](./getting-started.md): it installs the dashboard, connects a server and deploys a first app. [Hosting](./hosting.md) has the details of the dashboard, and [Connecting a server with one command](./reference/relay.md#connecting-a-server-with-one-command) the details of the default way to connect a server, which opens nothing on the server. [Servers](./reference/servers.md) covers the alternative, where the dashboard reaches the agent over mutual TLS. To serve an app on your own domain, see [Serve apps on a domain](./reference/proxy.md#serve-apps-on-a-domain).

## Guides

| Page | What it covers |
|---|---|
| [Getting started](./getting-started.md) | Install the dashboard, connect a server, deploy an image and roll it back |
| [Hosting the dashboard](./hosting.md) | Install, environment variables, lost password, what to back up, reaching agents, the GitHub webhook and App, domains, API tokens, variables, a hardening checklist |
| [The dashboard](./dashboard.md) | What it shows and does, how GitHub is connected, versions |
| [Moving a site that already runs](./migrating.md) | Bringing an existing site into Keelson through a staging address, and the checks for sites with data |
| [GitHub Action](./github-action.md) | Deploy from CI with a signed request; the job fails unless the new version is healthy |
| [MCP server](./mcp.md) | Let an AI assistant read your servers and, with a `deploy` token, deploy and roll back |

## Reference

The agent, one page per area. Each page has the YAML keys, the behaviour and the API routes of its area; [API](./reference/api.md) lists all routes.

| Page | What it covers |
|---|---|
| [The agent](./reference/agent.md) | Commands, flags, environment variables, read-only routes |
| [Configuration](./reference/configuration.md) | The apps file, one file per project, editing while the agent runs, versions and the audit log |
| [Deployments](./reference/deployments.md) | In-place and blue/green deployments, phases, the soak, release steps, housekeeping, deploy routes |
| [Builds](./reference/builds.md) | Building on the server or on another server, presets, `build_limits`, linking an app to its repository |
| [Previews](./reference/previews.md) | One environment per pull request |
| [Reverse proxy](./reference/proxy.md) | Serving apps on a domain, Caddy (apps, static sites, redirects, certificates, access log) and nginx |
| [Environment variables and secrets](./reference/environment.md) | The write-only variable store |
| [Scheduled jobs](./reference/jobs.md) | HTTP, host and container jobs |
| [Databases and backups](./reference/databases.md) | Declared and managed PostgreSQL, encrypted backups, restore, restore tests |
| [Notifications](./reference/notifications.md) | Events, Telegram, webhook, heartbeat |
| [Delivery performance](./reference/delivery.md) | The four DORA numbers: how they are computed, the route, the Prometheus series |
| [Metrics](./reference/metrics.md) | `GET /metrics` for Prometheus: what is exported, scraping, alert rules |
| [Agents that connect out](./reference/relay.md) | The default way to connect a server: one command, one outbound connection, build machines |
| [Installing and connecting servers](./reference/servers.md) | The alternative: direct connection over mutual TLS, enrolment codes, removing the agent |
| [API](./reference/api.md) | Authentication, signed requests, every route |
| [Security model](./reference/security.md) | What protects the agent and the dashboard |

## Concepts and project

| Page | What it covers |
|---|---|
| [Architecture](./architecture.md) | Components, state, how servers are reached |
| [Known limits](./limitations.md) | What is not supported or not verified |
| [Configuration schema v1](./schema.md) | What changed in the schema, `config migrate`, the dump used to prove a change safe |
| [UI guidelines](./design.md) | Layout, wording and checks for dashboard screens |
| [Development](./development.md) | Building and testing each component |

## Examples

Complete apps files in [`examples/`](./examples). Each starts with a comment saying what it shows.

| File | Shows |
|---|---|
| [`shop-production.apps.yaml`](./examples/shop-production.apps.yaml) | A Next.js site with a native PostgreSQL behind nginx: builds on the server, release steps with a backup, jobs, notifications |
| [`shop-production-caddy.apps.yaml`](./examples/shop-production-caddy.apps.yaml) | The same site served by the agent's Caddy |
| [`shop-staging.apps.yaml`](./examples/shop-staging.apps.yaml) | A staging environment beside production |
| [`web-postgres.apps.yaml`](./examples/web-postgres.apps.yaml) | A Next.js app on a managed PostgreSQL behind Caddy: a build that reads its database, release steps, a job, and a commented-out previews template |
| [`proxy-sites.apps.yaml`](./examples/proxy-sites.apps.yaml) | Static sites, redirects and a fixed upstream behind Caddy |
| [`build.apps.yaml`](./examples/build.apps.yaml) | An app built on the server |
| [`preset-nextjs.apps.yaml`](./examples/preset-nextjs.apps.yaml), [`preset-node`](./examples/preset-node.apps.yaml), [`preset-vite`](./examples/preset-vite.apps.yaml), [`preset-static`](./examples/preset-static.apps.yaml) | Build presets: no Dockerfile in the repository |
| [`previews.apps.yaml`](./examples/previews.apps.yaml) | Per-pull-request previews |
| [`dev-environment.apps.yaml`](./examples/dev-environment.apps.yaml) | A development environment |
| [`fail2ban-caddy/`](./examples/fail2ban-caddy) | fail2ban filters for Caddy's JSON access log |

Every example is written in [schema v1](./schema.md) and loads without deprecation warnings.
