# Security model

Two components hold power. An agent with access to the Docker socket is root-equivalent on its server, so it signs requests, is read-only by default, audits every change and exposes nothing that does not need to be public. The dashboard holds a credential for every agent, which makes it the most valuable target in the system, and it is hardened for that.

## The agent

- **Per-agent identity.** Each server has its own credentials: a token, a deploy secret and, for a directly reached agent, a certificate authority. Nothing is shared across servers.
- **Two levels of API access.** Reading needs the bearer token. Anything that changes something (`POST`, `PUT`, `DELETE`) needs an HMAC signature keyed with the deploy secret, with a timestamp and replay protection. Being able to read the API never lets you change anything. See [API](./api.md#signed-requests).
- **Read-only by default.** Without an apps file the agent only issues `GET` requests to the engine and has no mutating routes. An agent started without a deploy secret is read-only for the dashboard.
- **Mutual TLS for a directly reached agent** (TLS 1.3 only). Every request without a verified client certificate gets `401` before any handler runs. The one exception is `POST /v1/enroll`, whose only credential is a single-use code ([Servers](./servers.md#enrolling-the-dashboard-with-a-one-time-code)). An agent that connects out has no listener at all ([Agents that connect out](./relay.md)).
- **A deploy request names a tag or a digest, never an image.** The repository comes from the apps file, so a caller of the API cannot make the agent run an arbitrary image. The one route that installs image content is the signed image import (`PUT /v1/apps/{app}/image/{tag}`). It needs the deploy secret and accepts only an archive whose manifest names exactly that app's repository and tag, checked against the SHA-256 in the signed address.
- **Secrets are write-only.** Environment values, job headers and bodies, webhook URLs and the heartbeat URL are replaced by `<hidden>` in everything the API returns, and stored variables are never sent back ([Environment variables and secrets](./environment.md)). Secrets are kept out of logs, events, errors, process arguments and the audit log.
- **Every change is audited.** Each authenticated request that changes something is recorded on the agent with its time, sender label, peer address, route, status and a detail ([Configuration](./configuration.md)).
- **Backups are encrypted to keys the agent never holds**, and a restore asks for the secret key each time ([Databases and backups](./databases.md)).
- **Builds run repository code.** A build executes the repository's Dockerfile on the building server, so enable it only for repositories you would trust with that Docker engine. Fork pull requests never build ([Builds](./builds.md)).

## The dashboard

- **The browser never talks to an agent.** Pages and streams go through the dashboard's own server, which holds the credentials. Live logs, stats and deployment events are relayed as Server-Sent Events, and closing the tab closes the upstream stream.
- **Secrets are encrypted at rest** (AES-256-GCM) with a key derived from `KEELSON_DASHBOARD_KEY`. They are write-only in the UI and are never sent to the browser or shown again.
- **One operator, with a second factor.** The password is stored as a scrypt hash. After it, sign-in can require an authenticator code (TOTP) or a recovery code. A passkey (WebAuthn, user verified) signs in on its own. `KEELSON_REQUIRE_2FA=true` refuses sessions that did not go through a second factor.
- **Sessions live in the database.** You can list and revoke them. A session goes idle after 2 hours and ends after 12. A revoked session stops working on the next request, for pages and APIs alike. Changing the password signs everyone out.
- **Sensitive changes ask for the password and the second factor again** (the unlock lasts ten minutes). This covers everything that decides what runs on a server or where it is reached: adding or importing a server, a connect code, creating a project from a repository, an app's image, command, volumes, variables, environment, domains, release steps, build, previews and source, where an app builds, a DNS record and the GitHub webhook secret. It also covers downloading a copy of the dashboard's database and removing a factor or a passkey. A test fails when a new action that changes something neither asks nor is on a reviewed list.
- **Failed attempts are throttled across restarts.** The limit is five failures in 15 minutes per client, where a client is an IPv4 address or a whole IPv6 /64, so rotating addresses inside a network does not give fresh attempts. Set `KEELSON_TRUST_PROXY=true` behind a reverse proxy so clients are told apart. A sign-in that passed the password has five tries at the second factor, then the password is asked again. 30 wrong second-factor codes in 15 minutes from anywhere slow every address down until the guessing stops. The dashboard logs a warning at start when it is served over https without a trusted proxy.
- **Audit log.** It records sign-ins, failures, security changes and revocations, and what an API token did or was refused. The Security page shows it.
- **Response hardening.** A nonce-based content security policy, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, HSTS over https, and an optional IP allowlist (`KEELSON_ALLOWED_IPS`).
- **Every entry point checks the session itself**: pages, server actions and stream endpoints. The proxy that redirects to the login page is a convenience, not the only check.
- **Deployments are signed** with the server's deploy secret exactly as the agent expects ([API](./api.md#signed-requests)). The dashboard has no other way to change a server.
- **API tokens are narrow.** A token has a scope (`read`, or `deploy`, which also deploys, rolls back and runs a job), an expiry and optionally a list of servers. It can never edit configuration, restore a database, delete a preview, read a secret or manage tokens ([Hosting](../hosting.md#api-tokens-rest-api-and-mcp)).

[Hosting](../hosting.md) covers running the dashboard safely (master key, reverse proxy, allowlist, backups), including a [hardening checklist](../hosting.md#hardening-checklist). The MCP server has its own [threat model](../mcp.md#5-threat-model).

## Known limits

- **One operator.** There are no accounts or roles. Whoever signs in can do everything the dashboard can.
- **The master key lives beside the database** unless you give it in `KEELSON_DASHBOARD_KEY`, so a copy of the whole data volume contains both. *Settings → Backup* never includes the key.
- **A replayed GitHub webhook** with a new delivery id is not caught by deduplication, because GitHub's signature covers the body, not the id. A delivery can only start what a push or pull request would.
- **The actor label** a client sends with a signed request (the name the audit log shows) is not part of the signature. It is a label, not an identity.
- **No audit retention policy.** The logs grow until you prune them.
- **The nginx driver's `sudo` rule** lets the agent test and reload nginx, which loads configuration the agent can write. It adds nothing beyond the Docker-group access the agent already has, but it is a second path to root.
- **The binary download route** carries the one-time connect code in its query string, which a reverse proxy may log. The code works once and expires.
- **Release artefacts are not signed.** CI scans the dependencies on every change (`govulncheck` for the agent, `pnpm audit` for the dashboard and the MCP server). A release carries build provenance (a GitHub attestation for each agent binary; provenance and an SBOM attached to the dashboard image) and a `SHA256SUMS` file. `install.sh` and the compose files are fetched over https from the release and have no signature, so read them before you run them or pin a `--version`. The scan is not a guarantee, and a new advisory is only noticed when CI next runs.
- **Requirements and support.** Servers need Linux with systemd and a Docker engine. The agent and its installer have been exercised on Debian 12 and 13. Other distributions are not verified, and hosts with SELinux enforcing, rootless Docker or podman are not supported. Binaries are built for amd64 and arm64 (amd64 hosts are not yet verified on a real server). The MCP server is not published to npm; build it from source ([MCP](../mcp.md)).
