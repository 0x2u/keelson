# Hosting the dashboard

The dashboard is a website that runs as one container on its own server and reaches your agents over the network. It holds credentials for every agent and can deploy to them, so it is the most sensitive thing you expose. This page covers running it, reaching agents and locking it down.

## Run it

`deploy/install.sh` is attached to every release:

```bash
curl -fsSL https://github.com/0x2u/keelson/releases/latest/download/install.sh | sudo sh -s -- --domain keelson.example.com
```

It needs Docker with the compose plugin (2.24 or newer). It writes `compose.yaml` (and a `Caddyfile` when you give a domain) to `/opt/keelson` (`--dir` changes that), starts the image `ghcr.io/0x2u/keelson-dashboard` (`--version v0.1.0` pins it), and prints the address and the setup token.

Without `--domain` the dashboard listens on `127.0.0.1:3000` and cookies are allowed over plain http. Reach it through an SSH tunnel to try it on one machine. A dashboard reached that way cannot connect another server, because the command it shows carries its own address, so for that use `--domain` or any public https address. With a domain, a Caddy in front gets the certificate and the dashboard is not published on the host.

Running the script again updates the install and changes nothing else (`.env` is only written when absent, or for a value you pass again). Compose files come from the release being installed, so image and files match. Three variables help when testing: `KEELSON_IMAGE` (a local image, no pull), `KEELSON_PORT` and `KEELSON_RELEASE_URL`.

**First run.** With no `KEELSON_DASHBOARD_KEY` and no `KEELSON_ADMIN_PASSWORD_HASH`, every page redirects to `/setup`, and `/api/*` and `/install` answer 503. While nothing is set up, the container log prints `Keelson setup token: <token>` at each start. The token is 24 random bytes, kept only as a SHA-256 for 24 hours. Each start voids the previous token, and setting the password consumes it. Wrong tokens are throttled like wrong passwords.

Enter the token with a password of 12 or more characters. Setup then opens your session and shows the recovery file (`keelson-recovery.txt`: the master key, and what to do with it). You must download it before *Continue*. After that you are offered a second factor.

The master key is generated into `/data/master.key` (mode 0600), and the database never starts without it when it holds encrypted data. The password hash is kept in the database. Environment variables win. With `KEELSON_ADMIN_PASSWORD_HASH` set there is no setup and the stored password is ignored. With `KEELSON_DASHBOARD_KEY` set no key file is made and no recovery file is offered. A copy downloaded from *Settings → Backup* leaves out the master key, the password hash and the setup state, so a restored dashboard asks for a new password.

A generated key beside the database means that anyone who can read the volume can read the stored server credentials. For a stricter setup, keep the key out of the volume: put it in `KEELSON_DASHBOARD_KEY` (from a secret manager or a root-only file) and treat the recovery file only as your own copy.

To run the image yourself, or to change anything, use the same image the compose file uses, with the variables below in an env file:

```bash
docker run -d --name keelson-dashboard --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file keelson-dashboard.env \
  -v keelson-dashboard-data:/data \
  ghcr.io/0x2u/keelson-dashboard:latest
```

Put a reverse proxy that terminates TLS in front of it (Caddy, nginx, Cloudflare). The compose file reads an optional `dashboard.env` beside it for these. `keelson-dashboard.env`:

```bash
KEELSON_DASHBOARD_KEY=...            # pnpm run generate-key: 64 hex characters
KEELSON_ADMIN_PASSWORD_HASH=...      # pnpm run hash-password: 12+ characters
KEELSON_PUBLIC_URL=https://keelson.example.com   # needed for passkeys
KEELSON_TRUST_PROXY=true             # you are behind a reverse proxy that sets X-Forwarded-For
KEELSON_REQUIRE_2FA=true             # recommended once you have set up a second factor
# KEELSON_ALLOWED_IPS=203.0.113.7, 10.0.0.0/8
```

| Variable | Meaning |
|---|---|
| `KEELSON_DASHBOARD_KEY` | Master key. Encrypts the agents' tokens and secrets at rest and signs sessions. **If you lose it, the stored credentials are unreadable** and you re-add every server. Keep a copy in a password manager, apart from the data volume. |
| `KEELSON_ADMIN_PASSWORD_HASH` | scrypt hash of the operator password. Changing it signs every session out. |
| `KEELSON_PUBLIC_URL` | The https address the dashboard is served at. Connecting GitHub (GitHub calls the dashboard back over https), passkeys (bound to its host name) and the connect command of a server all need it. `http://localhost` also works, for development. With the install script, `--domain` sets it: run the script again with `--domain` on an installed dashboard. Behind your own proxy, put it in `dashboard.env` beside `compose.yaml` and run `docker compose up -d` there. Deploying an image does not need it. |
| `KEELSON_TRUST_PROXY` | Read the client address from `X-Forwarded-For`. Set it **only** behind a proxy that overwrites that header. Without it every client shares one login-throttle bucket, so someone can lock you out by failing five times. |
| `KEELSON_TRUSTED_HOPS` | With `KEELSON_TRUST_PROXY`, how many proxies sit in front of the dashboard (1 by default; 2 for Cloudflare in front of a reverse proxy). The address is read from the **right** of `X-Forwarded-For`, that many entries in. What a client writes at the left is never trusted, so it cannot pick its own throttle bucket or get past `KEELSON_ALLOWED_IPS`. |
| `KEELSON_CLIENT_IP_HEADER` | A header your proxy sets to the real address and overwrites (`CF-Connecting-IP` behind Cloudflare). Takes precedence over `X-Forwarded-For`. |
| `KEELSON_REQUIRE_2FA` | A session opened with the password alone may only reach the page where a second factor is set up; everything else needs a session that went through one. |
| `KEELSON_ALLOWED_IPS` | Addresses and CIDR ranges allowed to reach the dashboard at all (everything else gets 403). Needs `KEELSON_TRUST_PROXY=true`; the dashboard refuses to serve rather than guess when it is missing. |
| `KEELSON_DASHBOARD_DATA_DIR` | Database directory (`/data` in the image). |
| `KEELSON_INSECURE_COOKIES` | Local plain-http use only: drops the `Secure` flag and HSTS. It has no effect when `KEELSON_PUBLIC_URL` is an https address (the cookie is always Secure then), so the compose file can set it for its loopback default. |
| `KEELSON_UPDATE_CHECK` | `off` stops the daily request to `api.github.com` that finds out the latest release for the *Update available* notice (on by default; see [Upgrading](#upgrading)). |

First sign-in: open the site, sign in with the password, then go to **Settings, Security** and set up an authenticator app and/or a passkey. Keep the recovery codes somewhere safe. Each works once.

## Lost password

There is no "forgot password" screen, and the password is stored as a hash that cannot be read back. `KEELSON_ADMIN_PASSWORD_HASH` always wins over the password chosen at setup (the dashboard reads the variable first, then the stored one), so you reset it from the server:

1. On any machine with Node 24 and a checkout of this repository, run `pnpm install` then `pnpm run hash-password` in `dashboard/`. It reads a new password (12 or more characters) without echo and prints `KEELSON_ADMIN_PASSWORD_HASH=…`. The image does not carry this script.
2. Put that line in `dashboard.env` beside `compose.yaml` (`/opt/keelson` with the install script) and run `docker compose up -d` there.
3. Sign in with the new password. Changing the variable signs every session out.

The master key and the data volume are untouched, so servers, tokens and settings are still there. Any authenticator app or passkey you set up still applies. If you lost those too, use a recovery code.

## What to back up

The `/data` volume holds the server registry (encrypted), the second factors and the audit log. Without it you re-add your servers and set the second factor up again. With it you also need `KEELSON_DASHBOARD_KEY`, or the credentials inside are unreadable. Your sites, deployments and databases are not stored there. They stay on the agents.

**Download a copy** in *Settings → Backup* (it asks you to unlock first). It is a consistent copy of the database (`VACUUM INTO`) without the master key, the sessions, the login failures or the pending GitHub App states. It is streamed to you and deleted from the server afterwards. It holds credentials encrypted under `KEELSON_DASHBOARD_KEY`, so keep the key somewhere else. The readiness checklist warns when the last download is older than 30 days.

The image also holds the agent binaries (`/app/agent-bin`, found through `KEELSON_AGENT_BIN_DIR`). When you add a server by SSH the dashboard uploads that exact version and checks its SHA-256 on the server, so nothing is downloaded and dashboard and agent match. Outside Docker, build the binaries with `scripts/build-agent.sh` and point `KEELSON_AGENT_BIN_DIR` at the output.

The SSH login you type when adding a server is used for that one request and never stored. The dashboard needs to reach the server's SSH port and, afterwards, the agent's port (7443 by default). The installer can open that port in ufw for the dashboard's address.

## Upgrading

Back up, update the dashboard, then update each server's agent.

1. **Back up.** *Settings → Backup* downloads a copy of the database (see [What to back up](#what-to-back-up)). Keep the recovery file with your master key too.
2. **Update the dashboard.** On the machine that hosts it, run the install command of the release you want:

   ```bash
   curl -fsSL https://github.com/0x2u/keelson/releases/download/vX.Y.Z/install.sh | sudo sh -s -- --version vX.Y.Z
   ```

   The command is the same with or without a domain. It keeps the data volume, the master key, the settings in `.env` (and `dashboard.env`) and the domain. A changed compose file is replaced, and the old one is kept as `compose.yaml.old`. A newer release migrates the database forward, and an older one cannot read the result. So before each update of a running dashboard the script **copies the database** to `/opt/keelson/backups/dashboard-<date>.db` (mode 0600, the last three are kept). If the copy fails it says so and goes on, which is why step 1 comes first. The release notes list what changed.
3. **Update each server's agent** from its **Update** page. A server that connects out shows a command to run on that server (there is no button). A server added over SSH has a wizard on the same page. Servers keep running their apps while the agent is updated.

**Downgrades are not supported.** The new version may already have migrated the database. To go back, restore the copy taken before the update (the one the script printed, or your download from *Settings → Backup*; see [Restore the dashboard](#restore-the-dashboard)) and run the install command with the previous `--version`.

**Pin the version in production.** `KEELSON_VERSION` in `/opt/keelson/.env` is the release the dashboard runs, and the install command with `--version` writes it. The default, `latest`, moves the next time `docker compose pull` runs. Use a fixed `vX.Y.Z` and update when you decide to.

**Update available.** Once a day the dashboard asks `api.github.com` for the latest release and shows *Update available* in *Settings* when yours is older. The request carries the dashboard's IP address and a User-Agent with the dashboard version, and nothing else. Set `KEELSON_UPDATE_CHECK=off` (in `dashboard.env`, then `docker compose up -d`) to make no outbound call at all.

## Restore the dashboard

You can restore from a copy downloaded in *Settings → Backup* (or one the update script left in `/opt/keelson/backups`), on this machine or a new one. The copy holds your servers' credentials **encrypted with the master key, and the key is not in it**. Without the key the dashboard starts but reports itself unhealthy (`/api/health` answers 503) and a server's card says its credentials cannot be read. The key is in your recovery file (`keelson-recovery.txt`, the line `KEELSON_DASHBOARD_KEY=…`), or in `master.key` of the data volume of the machine that made the copy.

1. On a new machine, install the dashboard as usual (`install.sh`), but **do not complete the setup page**, then stop it: `cd /opt/keelson && docker compose down`. (The volume is `keelson_data`; `docker volume ls` shows it if you used another `--dir`.)
2. Put the master key and the copy in the volume. Run this next to the copy, with `KEY` the 64 characters from the recovery file and `FILE` the name of the copy:

   ```bash
   KEY=...; FILE=keelson-dashboard-20261102-120000.db
   docker run --rm -e KEY -e FILE -v keelson_data:/data -v "$PWD":/in alpine sh -c '
     rm -f /data/dashboard.db-wal /data/dashboard.db-shm
     printf "%s\n" "$KEY" > /data/master.key && chmod 600 /data/master.key
     cp "/in/$FILE" /data/dashboard.db
     chown 1000:1000 /data/master.key /data/dashboard.db'
   ```

   If you keep the key in `KEELSON_DASHBOARD_KEY` instead, put it in `dashboard.env` and leave out the `master.key` line.
3. `docker compose up -d`. Every server, token and setting is back. The copy leaves out sessions and the setup password, so the first visit asks for a **new setup token** (printed in `docker compose logs dashboard`) and a new password.

## If you lose the master key

Without the key the stored credentials of your servers cannot be read, and nothing can bring them back. You lose the server registry (tokens, deploy secrets, certificates and keys), the authenticator secret, the stored third-party tokens (GitHub, Cloudflare) and the webhook secret. Your apps, databases and backups live on the servers and keep running.

To start over:

1. `cd /opt/keelson && docker compose down`, then delete the database from the volume (and the stale key file, if there is one you cannot match with a recovery file):

   ```bash
   docker run --rm -v keelson_data:/data alpine sh -c 'rm -f /data/dashboard.db /data/dashboard.db-wal /data/dashboard.db-shm /data/master.key'
   ```
2. `docker compose up -d`, open the address with the new setup token from the log, choose a password and **download the new recovery file**.
3. Connect each server again. A server that connects out no longer has a credential the dashboard knows, so its agent stops by itself. On the server run `sudo keelson-agent uninstall` (the apps keep running; the files stay in `/etc/keelson` unless you add `--purge`), then use *Servers → Add server → Connect with one command* and run the new command ([Agents that connect out](./reference/relay.md)). For a server added over SSH, use *Add server* again. Installing over an existing agent keeps its secrets and issues a new client certificate ([Servers](./reference/servers.md#other-ways-to-add-a-server)).

## Uninstall the dashboard

```bash
cd /opt/keelson
docker compose down        # stops it; the data volume stays, so installing again finds everything
docker compose down -v     # also deletes the data volume: the database and the master key are gone
```

Download a backup and keep your recovery file before `down -v`. Servers you connected keep running their apps, but nothing manages them any more. Uninstall their agents with `sudo keelson-agent uninstall` (see [Servers](./reference/servers.md#removing-the-agent)). Remove `/opt/keelson` afterwards if you want the files gone too.

## Reaching the agents

The recommended way is the other direction. *Servers → Add server → Connect with one command* installs an agent that connects out to the dashboard (`curl -fsSL https://<dashboard>/install | sudo sh -s -- --code …`), so the server opens no port and holds no certificate. The dashboard must then be reachable from the servers over HTTPS. Set `KEELSON_PUBLIC_URL`, and make sure a proxy in front does not buffer or time out the streamed response on `/api/relay/connect`. The paths below are for an agent the dashboard reaches at a URL. Pick one per server:

| Path | How | Notes |
|---|---|---|
| **Private network** | WireGuard or Tailscale between the dashboard host and the server. The agent listens on the private address. | Nothing about the agent is public. Use `--allow-insecure-http` only if the link itself is encrypted. Not run end to end yet. |
| **Public with mutual TLS** | The agent listens on a public address with `--tls-cert`, `--tls-key` and `--tls-client-ca`. The dashboard presents a client certificate (Settings of the server: CA certificate, client certificate and key). | TLS 1.3 only. Without the client certificate the connection is refused before any request. Tested end to end. |
| **Cloudflare Tunnel** | `cloudflared` on the server exposes the agent's loopback port under a hostname. | No inbound port at all. Cloudflare terminates TLS, so mutual TLS does not apply, and the API token and the signed requests are the protection. Consider a Cloudflare Access policy in front. Not run end to end yet. |

On every path, the API token (read access) and the deploy secret (signed changes) still apply. An agent started without a deploy secret is read-only for the dashboard.

**Pairing with a one-time code (mutual TLS).** Run `sudo keelson-agent enroll-code` on the server and paste the line it prints into *Add server → Enrol with a code*. No SSH access is needed, only a route from the dashboard to the agent's port. The dashboard pins the agent's certificate by the SHA-256 fingerprint in the line (TLS 1.3, no redirects, 10 s timeout), sends the one-time code only after the fingerprint matches, then stores the token, deploy secret, CA certificate and a fresh client certificate. The line is never stored or logged. Its address gets the same checks as in the other forms (https, no credentials, path, query or fragment), and the dashboard connects to it, so on a shared network be careful about who may sign in. Details: [Servers](./reference/servers.md#enrolling-the-dashboard-with-a-one-time-code).

## A computer that connects out (build machine)

The paths above all need the dashboard to reach the agent. A laptop behind a router cannot be reached, so it connects the other way: *Servers → Add server → Advanced → A computer that connects* makes a code (single use, 30 minutes) and shows the command to run on that computer. It needs Docker running (on a Mac, Docker Desktop open) and a route to the dashboard's address over HTTPS. Behind a proxy, set `KEELSON_PUBLIC_URL` so the command carries the right address, and make sure the proxy does not buffer or time out the streamed response on `/api/relay/connect` (the agent reconnects by itself when it does).

What such a machine can and cannot do (it builds, it never serves), its files and its security are in [Agents that connect out](./reference/relay.md#a-computer-that-connects-out-keelson-agent-connect). Offline is normal for a laptop: the dashboard lists it as *Offline* with its last seen time, does not count it as an incident, and disables its *Build on* card until the agent runs again (`./keelson-agent connect`, which keeps `~/.keelson`).

## GitHub webhook (automatic deploys and previews)

`POST /api/webhooks/github` is the one dashboard endpoint reachable without a session. GitHub cannot sign in and cannot reach the agents (mutual TLS, private network), so GitHub talks to the dashboard and the dashboard talks to the agents as usual. The endpoint answers 404 until a webhook secret exists.

GitHub has to reach the dashboard from the internet. `KEELSON_ALLOWED_IPS` stays in force for this path (it is checked before anything else), so if you use it, also allow GitHub's webhook ranges: `curl -s https://api.github.com/meta`, key `hooks`. Behind a reverse proxy, pass this path through to the dashboard like the rest, and keep `KEELSON_TRUST_PROXY=true` for the allowlist.

To set up the webhook on GitHub, go to the repository, Settings, Webhooks, Add webhook. The values to copy are on the dashboard's *Integrations* page, in the collapsed *Advanced / manual setup* section. *Connect GitHub*, below, creates the secret for you and needs no repository webhook for the App's builds.

| Field | Value |
|---|---|
| Payload URL | `https://<your dashboard>/api/webhooks/github` (the page builds it from `KEELSON_PUBLIC_URL`, else from the address you opened it at) |
| Content type | `application/json` (anything else is refused with 415) |
| Secret | the one generated on *Integrations* (shown once; regenerating replaces it, removing deletes it) |
| Events | *Let me select individual events*, then only **Workflow runs** and **Pull requests** (the second only for previews). The GitHub App (below) has its own event list: **Push** and **Pull request** |

Then, on the app's **Source** page, turn on *Automatic deploys* and name the workflow (the name GitHub shows for the run). That workflow must build **and push** the image tagged with the commit SHA (`${{ github.sha }}`). The deployment is `agent deploy` of that tag, the same convention the Source page uses to find the serving commit. One repository can feed several apps on several servers: each linked app with a matching branch and workflow is deployed.

**What deploys.** A `workflow_run` delivery that is `completed` with conclusion `success`, event `push`, `workflow_dispatch`, `schedule` or `release`, from the repository itself (no fork builds), with a full 40-character head SHA, on the linked branch, from the configured workflow. Everything else is acknowledged and ignored (a `ping` is answered).

For each app the dashboard skips a commit that is already serving, and a commit that GitHub says is strictly behind the serving one ("older than what is serving"), so runs that finish out of order cannot roll the app back. When the commit cannot be placed against what serves, the outcome is `skipped` with the reason "ordering unknown" (no GitHub token, a serving image not tagged with a commit, or a comparison that failed or took longer than 3 s) or "diverged" (a force push), and a later delivery evaluates it again. An app that serves nothing yet deploys its first commit without a comparison. To start automatic deploys on an app that serves a tag such as `v1`, deploy a commit-tagged image once.

If the agent does not answer within 3 s the outcome is `unknown` (shown as Unknown on the Source page). The deployment may have started, so the same commit is not deployed again while the app cannot be read. A deployment already running on the server is reported as failed. The dashboard answers GitHub per app without waiting for the deployment, and each delivery that was acted on is a line in the audit log (never the secret).

**Previews.** On the app's **Source** page, *Previews* turns on one preview environment per pull request (`<app>-pr-<n>`, declared by the `previews:` template in the app's agent apps file) and names the workflow that builds and pushes the pull request's image tagged with the head commit SHA. The same webhook drives it:

- A `workflow_run` delivery makes the dashboard send a signed `PUT /v1/previews/<app>/<pr>`, which creates or redeploys the preview. It must be `completed` with conclusion `success`, event `pull_request` (not `pull_request_target`, which runs with the base's secrets), from the repository itself (a fork never gets a preview), with a full 40-character head SHA, from the configured workflow, for a pull request that merges into the linked branch. A run that finishes after a newer commit of the same pull request is already serving is skipped when GitHub proves it older (this needs a token). Production deploys refuse every pull request run.
- A `pull_request` delivery with action `closed` (merged or not) sends a signed `DELETE /v1/previews/<app>/<pr>` for every app linked to that repository with previews on. If a deployment is still running, the agent refuses (409) and the preview ends with its time limit. A run that finishes after its pull request was closed, or for a commit the pull request has moved past, is skipped. Detecting that needs a token (`GET /repos/<repo>/pulls/<n>`, 3 s). Without one, or when GitHub is slow, the preview is created anyway.
- Deliveries are recorded under the preview's name (`shop-pr-12`), so a preview and a production deploy of the same commit never block each other. The page lists the live previews (name, address, status, commit, expiry) with a delete button and the latest preview deliveries. Turning previews off offers to remove the running ones too (checked by default).
- **Commit status (optional).** With a GitHub token connected, the dashboard posts the commit status `keelson/preview` on the head commit: `pending` once the agent accepts the deployment, then `success` (linking the preview's address) or `failure`, following the deployment for up to 10 minutes. With the `keelson/build` status of the GitHub App (below), this is the only thing Keelson writes to GitHub, and it needs the token permission **Commit statuses: read and write**. Without a token, or when GitHub answers 403 or 404, previews work all the same and the delivery's detail says `status not reported: <reason>`.

**Security notes.** The HMAC (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body with the secret) is verified in constant time on the raw bytes **before** the body is parsed or the database is read, and a missing or wrong signature is a bare 401. Bodies above 1 MiB are refused (413). The secret is 32 random bytes, stored encrypted and write-only: the page shows it once. Pull request and fork runs never deploy to an app. A pull request of the repository itself (someone with write access) can create a preview, which runs only the image its workflow built, in its own environment without the app's variables or volumes. The endpoint is public and has no rate limit of its own, so keep the allowlist or a firewall rule in front of it when you can.

## GitHub App (build and deploy from pushes and pull requests)

Install a GitHub App on a repository and Keelson builds and deploys its pushes and pull requests, without a CI workflow. The build runs on the agent of the target server, only when you turn it on for that app. The dashboard hands the agent a short-lived token and the address of the source tarball. The agent downloads it, builds it with Docker, tags it `<image>:<sha>` locally and deploys it through the usual pipeline (release steps, health gate, rollback). No registry is involved. It works beside *Automatic deploys*, and both can be on for one app.

**1. The agent.** The app needs a `build:` block in the agent's apps file (`dockerfile`, `context`, `target`, non-secret `args`, `timeout`, `memory`, `cpus`, `max_source`, `source_hosts`; or a `preset` that generates the Dockerfile in place of `dockerfile` and `target`, see [Build presets](./reference/builds.md#build-presets-no-dockerfile-in-the-repository)), and for pull requests a `previews` block. An app without one answers the build request with 400, and the dashboard shows the agent's message on the app's Source page and in the delivery.

**2. Connect GitHub** (*Integrations*, the *GitHub* card). You create nothing by hand: the dashboard uses GitHub's [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

1. Click **Connect GitHub**. Choose a name (a short random suffix is proposed, because App names are unique across GitHub) and whether the App belongs to your account or to an organization. The button is off, with the reason, unless `KEELSON_PUBLIC_URL` is an **https** address, because GitHub calls the dashboard back on it and the App's webhook uses it. (`http://localhost` is accepted only with `KEELSON_INSECURE_COOKIES=true`, for development.)
2. The dashboard creates a **single-use state** (32 random bytes, stored only as a hash, bound to your session, valid for 10 minutes) and posts the manifest to GitHub. GitHub shows one *Create GitHub App* button, the only approval.
3. GitHub redirects to `/api/github/app/callback`. The dashboard requires your session, checks and consumes the state (a missing, expired, reused or foreign state is refused and nothing is stored), exchanges the code with GitHub (`POST /app-manifests/{code}/conversions`) and stores the **App ID, the private key and the webhook secret** GitHub generated, encrypted and write-only. The App's `client_id` and `client_secret` are not stored. The webhook secret becomes the dashboard's webhook secret, so there is no second one to keep in step.
4. You land on GitHub's install page for the App. Choose the account or organization and the repositories, and install. GitHub returns to *Integrations*, which lists the repositories the App can reach (with a *Private* badge), a link to the App's settings on GitHub, *Install on more repositories* and *Disconnect*. If the App is not installed yet, the page says so and has the install link and a *Refresh*.

The manifest asks for a **private** App (installable only by its owner) with the events and permissions in the table below, the webhook `<KEELSON_PUBLIC_URL>/api/webhooks/github`, the callback `<KEELSON_PUBLIC_URL>/api/github/app/callback` and the setup URL `<KEELSON_PUBLIC_URL>/settings/integrations?github=installed`.

**Replacing the App.** Connecting again while an App or a webhook secret exists replaces both, and the old App's webhooks stop working at once (it stays on GitHub, so delete it there). The dashboard asks for confirmation and your password first. *Disconnect* deletes the stored key and turns every app's builds off.

**The callback and the session cookie.** The session cookie is `SameSite=Strict`, so the redirect back from github.com carries none. The dashboard bounces through a small page with `hop=1` to get the cookie back before it requires the session. That is why `/api/github/app/callback` is let through the proxy's session redirect and checks the session itself.

**Advanced / manual setup** (the collapsed section at the bottom of *Integrations*) is the manual way. Create the App yourself (GitHub, Settings, Developer settings, GitHub Apps, New) with the values below, generate a private key, install it on the repositories you deploy, then paste the App ID, the key (the whole `.pem`) and optionally the App's name into the *GitHub App* card there. The dashboard checks the credentials with GitHub (`GET /app`) before saving them.

| Field | Value |
|---|---|
| Webhook URL | `https://<your dashboard>/api/webhooks/github` (the same address as the webhook above) |
| Webhook secret | the secret of the *GitHub webhook* card (same section). Use **the same one**, so an App and repository webhooks can coexist |
| Repository permissions | **Contents: read**, **Commit statuses: read and write**, **Pull requests: read**, **Actions: read** (to list a branch's workflow runs on the Source page), **Metadata: read** (always on). Nothing else |
| Subscribe to events | **Push** and **Pull request** |
| Where can it be installed | the account that owns the repositories |

The read-only token (the *GitHub* token card, also under Advanced) is optional. It only feeds the commits and CI runs on the Source page, and an app can be linked with the App alone (the installation proves the repository is reachable).

**3. Per app**, on its **Source** page, the *GitHub App build* card has two switches, both off by default and switchable on only once an App is set up: *build and deploy each push to the linked branch*, and *build and deploy a preview of each pull request*. Linking the app to another repository or branch turns both off.

**What builds.**

- A `push` delivery that updates the linked branch (`refs/heads/<branch>`; not a tag, not a deletion), names a full 40-character commit and carries an `installation` (it came through the App). The dashboard asks the agent, with a signed `POST /v1/apps/<app>/build`, to build that commit and deploy it.
- A `pull_request` delivery with action `opened`, `reopened` or `synchronize`, merging into the linked branch, carrying an `installation`, from a branch of **the same repository**. Forks never build, and neither does a pull request whose head repository was deleted. The dashboard sends a signed `PUT /v1/previews/<app>/<pr>` with the commit and the source instead of a tag. `closed` removes the preview as before, for apps that build previews too.
- Everything else is acknowledged and ignored. The answer says only that the build was accepted and does not wait for it. The skip rules are those of the workflow path above, and a pull request is also skipped when its head moved on, when it is closed, or when its preview already serves the commit.

**The source token.** For each build the dashboard asks GitHub for an installation token limited to **that repository** and to the permissions above. It is cached in memory for 50 minutes and never written to SQLite, the audit log, delivery rows, events or logs. It reaches the agent only in the signed request body, and the agent strips it when a download redirects to another host. The agent downloads `https://api.github.com/repos/<repo>/tarball/<sha>`. Only github.com is supported, not GitHub Enterprise Server (the agent's `source_hosts` already allows it).

**One commit, one deployment.** Deliveries are claimed like the workflow ones, so a redelivery or two simultaneous deliveries build once. An accepted build holds its commit for 75 minutes: a CI workflow run for the same commit that finishes meanwhile is **skipped** ("a GitHub App build of this commit has started deploying it"). A build or deployment that fails releases the commit at once, and the delivery becomes `failed` with the agent's reason.

**Reporting.** After the answer, the dashboard posts the commit status `keelson/build` as the App (`pending` "Building", then `success` "Built and deployed" or `failure` with the reason), linking the deployment's page when it knows the address (`KEELSON_PUBLIC_URL`). A pull request also gets `keelson/preview` with the preview's address. It follows the deployment for up to 75 minutes. A status that cannot be posted never fails the delivery, and if the dashboard restarts meanwhile the status stays `pending`. An older agent (404 or 400 on the build request) is recorded as `failed` with its message.

**Security notes.**

- **A build runs the repository's Dockerfile on the target server.** Anyone who can push to a linked branch, or open a pull request from a branch of the same repository, can run code on that server (with the agent's memory and CPU caps, no privileged mode, no host network and no Docker socket). That is why it is opt-in per app. Link production only to a protected branch, and use a separate staging server for pull request previews.
- Forks never build. Builds get **no secrets**: secret build arguments, build-time credentials and BuildKit secrets are **not supported**, so a Dockerfile that needs private registry credentials cannot be built this way.
- The App's permissions are the minimum above: it reads contents, pull requests and Actions runs and writes commit statuses. An App created before Actions was added shows "Could not load the workflow runs" on the Source page: in the App's settings on GitHub, set Repository permissions, Actions to Read-only, then accept the change on the installation. Builds keep working in the meantime. Every build leaves an image on the target server, bounded by the agent's `keep_images` and image pruning.

## Add an app from a repository

With the GitHub App set up, **New project → From a repository** (also reached from the server page's *Apps* card, an app's *Source* page and *Integrations*) takes an app from a repository to a first deployment without writing the `build:` block by hand. It is behind the session like every page.

1. **Pick** a repository from the list of those the App can reach (searchable). Opened from a server page, the app goes to that server. From *Integrations* you also choose one of the online servers that can be changed from here. Without an App the page says so and links to *Integrations*.
2. **Detected.** With an installation token for that one repository, the dashboard reads the repository, its head commit and the `contents` of the root, `docker/`, `deploy/` and one level of subdirectories. It finds the default branch and the Dockerfile (`Dockerfile`, `docker/Dockerfile`, `Dockerfile.prod`, `deploy/Dockerfile`, then `<dir>/Dockerfile`), with the root as build context for the first four and the directory otherwise. The container port is the first TCP port of the **last `EXPOSE` of the final stage**. A variable such as `EXPOSE $PORT`, a range or no `EXPOSE` is **not guessed**, and the port is asked. An image with a `HEALTHCHECK` needs no health path. The name is the repository's, adjusted to the agent's name rules, with a number added if an app already has it.
3. **Asked.** Everything above is an editable default, and nothing is written before the button. You confirm the name, branch, Dockerfile and context, container port, and how the app is exposed: **a domain** (Caddy proxy only, with an optional health path) or **a local port** on `127.0.0.1` (the first port from 8100 that no app of the agent uses; the agent ignores a health path without a domain). The domain's DNS record must point at the server. Keelson creates it at Cloudflare when that is connected, and otherwise tells you what to create (see *Domains*). Optional: an env file (a path on the server, because the dashboard never handles the app's secrets), build and deploy each push (on by default), previews (shown only when the agent has a `previews:` template for that app name), and build limits under *Advanced* (2g, 2 CPUs, 15m).
4. **Written.** The app goes into the agent's apps file through `PUT /v1/config/apps/<name>` (image `keelson-local/<name>`, a `build:` block with the Dockerfile relative to the context, `port` and `domains`, or `ports: ["127.0.0.1:<n>:<port>"]`, `health_path`, `env_file`). The call carries the hash of the document that was read and is refused if the name exists. Then come the DNS record for a domain, the repository link and build modes, and the first build of the branch head (started like a push, with the `keelson/build` status followed). The page then goes to the deployment. The agent's validation issues are shown verbatim. If a step after the write fails, earlier steps are **kept**, the page lists what is done, and you can retry the failed step (a retry never rewrites the configuration). Audit entries: `app_created_from_repo`, `repo_linked`, `build_modes`, `first_build_started` / `first_build_failed`.

## Add an app from an image

No GitHub is needed. **New project → From an image** (also reached by *Add app* on a server and by the empty server page) writes an app that runs a ready-made image and deploys a tag of it, with the same steps and agent calls as the other door:

1. **Asked.** The image **with its tag or digest** (`traefik/whoami:v1.10.3`, `ghcr.io/acme/web@sha256:…`). The app stores the repository, and the first deployment asks for the version. `latest` works only when you type it. Then a name (the image's by default), the server, the **container port** (80 by default; empty when the container publishes nothing), and either a **domain** (Caddy proxy only; DNS as in *Domains* below; optional health path) or **a port on the server**: the first free one from 8100, on `127.0.0.1` only unless *Let other computers connect* is ticked. That option listens on every interface over plain http with no password, and Docker publishes past a host firewall such as ufw. Optional: variables (paste a `.env`; write-only).
2. **Written.** The app goes into the agent's apps file through `PUT /v1/config/apps/<name>` (`image` as the repository, `restart: unless-stopped`, and `port` + `domains` + `health_path`, or `publish: ["127.0.0.1:<n>:<port>"]`; an app with neither is an in-place `replace` app). The call carries the hash of the document that was read and is refused if the name exists. It needs the unlock like any creation. Then come the variables, the domain's DNS record, and the first deployment (`POST /v1/apps/<name>/deploy`). Nothing is rolled back when a step fails: the page lists what is done and you can retry the failed step. Audit entries: `app_created_from_image`, `first_deploy_started` / `first_deploy_failed`.
3. **Reached.** Once the deployment is live, the page shows how to open the app: the domain, or `host:port`. The address is a link when the dashboard's browser can reach the host (the port is open to the network, or the server is this machine). For a loopback port of a remote server, the page gives the `ssh -L` command.

Pulling a private image needs the registry's credentials in the agent's `registries` list ([Deployments](./reference/deployments.md#the-apps-file)).

## Domains (Cloudflare DNS and domain checks)

To serve an app on a domain from scratch, start with [Serve apps on a domain](./reference/proxy.md#serve-apps-on-a-domain). With the Caddy driver the proxy host, the certificate (ACME) and ports 80 and 443 are automatic. This section covers creating the DNS record and checking that it worked. It is behind the session, and an API token (`/api/v1`, MCP) cannot reach any of it.

**Connect Cloudflare** (*Settings, Integrations*, the *Cloudflare* card). Create a *Custom Token* on Cloudflare's [API tokens page](https://dash.cloudflare.com/profile/api-tokens) with **Zone → Zone → Read** and **Zone → DNS → Edit**, limit *Zone resources* to the zones you put apps on, and paste it. Storing or replacing it asks for the password again. Before saving, the dashboard checks the token (`GET /user/tokens/verify`; a token that endpoint does not know, such as an account-owned one, is accepted when it can list zones) and lists the zones (`GET /zones`). The token is stored encrypted and write-only, and the card shows its status, expiry and zones. *Disconnect* asks for the password, and the records it created stay. Calls go to `https://api.cloudflare.com/client/v4` with an 8 second timeout and never follow a redirect.

**The server's public address** is what a domain must point at. It is the *Public address* of the server's settings when set (IPv4 or IPv6, stored in `servers.public_ip`, migration 12), otherwise the host of the agent's URL when that is an IP address, otherwise what that host name resolves to (IPv4 first). A **private, loopback, link-local or shared (`100.64.0.0/10`, Tailscale) address is refused for a public DNS record**. To use one anyway, tick *Use … anyway* in the wizard or the *Create the DNS record* dialog (the audit entry records it). IPv6 gives an `AAAA`.

**In the add-app wizard** the domain field shows the plan as soon as the host name is valid: *Create A shop.example.com → 203.0.113.7, proxied (zone example.com)*. **Proxied** means Cloudflare answers for the name and the origin address stays hidden (HTTP-01 still works through the proxy). **DNS only** leads the name straight to the server and exposes its address. Without a connected Cloudflare, or when no zone covers the host, the field shows a *Create this DNS record yourself* block with the exact type, name and content (each with a copy button) and a link to connect Cloudflare.

On *Add the app and build it* the steps are *write the app*, **point the domain at the server**, *link*, *build*. The DNS step is never rolled back. If it fails the later steps do not run, and the retry resumes from it. A record that already has the right content is left alone. **A record with another value is never overwritten silently**: the step stops, names the old value (`A 198.51.100.9`), and the retry button stays disabled until you tick *Replace A 198.51.100.9 with …*. A CNAME, which cannot sit beside an address, is deleted and the address created, after the same confirmation. Records are created with TTL automatic and `proxied: true` unless you chose DNS only. Every creation or replacement is in the audit log with the host, the zone and the old and new value, never the token.

**Domain status** is the *Domains* card on an app's page and on the server's *Proxy* tab. It lists each host name the agent declares (apps' `domains`, sites' `hosts`, apps still waiting for their first route) with three live checks. Each check is *OK*, *Waiting*, *Failed* or *Skipped*, with one line saying what was found and one saying what to do:

- **DNS**: what the system resolver answers (A and AAAA) and, when Cloudflare is connected, the record Cloudflare holds. A *proxied* record answers with Cloudflare's addresses, so its content is compared with the server's address instead. An address record with the wrong content is *Failed* whatever the resolver says (a hosts file, split-horizon DNS or a cache can hide it). A name that does not resolve yet, or a right record that resolvers do not show yet, is *Waiting*.
- **Proxy**: the host is in `GET /v1/proxy` (apps or sites), the app's container runs and the proxy serves what the agent generates. An app that declares the host but has no route yet is *Waiting* (the route appears at its first deployment).
- **HTTPS**: a TLS connection to **the server's own address on port 443 with the host name as SNI** (so it works before DNS propagates and whatever Cloudflare does). It reads the certificate (issuer, validity, whether it is valid for the name, time left, and whether its chain leads to a root the dashboard trusts). Then it makes an `HTTPS GET /` of the name through the normal path (system DNS, the certificate must verify, no redirect followed, 5 seconds) and reports the status. *Waiting* means the proxy has no certificate yet (Caddy is obtaining it) or DNS is not done. *Failed* covers nothing listening on 443, a timeout (a firewall), an expired or wrong-name certificate, a 5xx from the app and **a certificate that is not publicly trusted**, such as Caddy's internal authority (`tls: internal`).

The card checks when it appears and again every few seconds while a check is *Waiting* (5 seconds for the first minute, then 10, then 20). It stops when nothing is waiting or after ten minutes, and has a *Re-check* button. **SSRF guard**: only host names the agent itself declares are resolved, asked about at Cloudflare or probed, and only against the server's own address. An IP literal, an undeclared name or an unreachable agent is answered without touching the network. With Cloudflare's SSL mode *Full (strict)* an untrusted origin certificate is a real problem for visitors. In *Full* it is not, and the failure text says so.

## API tokens (REST API and MCP)

For scripts, CI jobs and AI assistants (through the MCP server) that should read this dashboard, and optionally deploy. **Settings, API tokens** creates them. A token is the credential for the REST API under `/api/v1`, and nothing else accepts it.

**Creating one** asks for the password again, a name, a **scope**, the servers it may reach and an **expiry** (default 30 days, at most 365; a token cannot be extended, so make a new one). The token (`kst_` and 43 characters) is shown **once**, with a copy button and the `KEELSON_URL` / `KEELSON_TOKEN` block for an MCP client. Only its SHA-256 is stored, with the first 8 characters to recognise it in the list. **Revoking** takes effect on the very next call. Creation and revocation are in the audit log.

- **`read`**: every `GET` below. **`deploy`**: also deploy, rollback and run a job. Nothing else is reachable with a token: no configuration edit, no database restore, no preview deletion, no secrets, no server added or removed, no token management (these routes do not exist under `/api/v1`) and no security setting.
- A token can be **limited to some servers**. The others answer `403` and do not appear in the lists. The dashboard-wide audit log (`/api/v1/audit`) needs a token that is not limited.
- No response carries an agent token, a deploy secret, a certificate or a key. A container's command line is left out (arguments are where passwords end up), and a job run's output is cut at 16 KiB.

Call it with `Authorization: Bearer kst_...`. Every response is JSON with `Cache-Control: no-store`; errors are `{"error": "..."}`.

| Call | Answer |
|---|---|
| `GET /api/v1/servers` | `{servers: [{id, name, url, online, agent_version, update_available, can_deploy}]}` (only the servers the token may see; `can_deploy` is true only for a `deploy` token on a server that has a deploy secret in this dashboard) |
| `GET /api/v1/servers/{id}/overview` | `{server, health, containers, apps}`: the data behind the server page |
| `GET /api/v1/servers/{id}/apps` | `{apps}` |
| `GET /api/v1/servers/{id}/deployments?app=&limit=` | `{deployments}` (limit 20 by default, at most 100) |
| `GET /api/v1/servers/{id}/deployments/{deployment}` | the deployment with its last 500 `events` (a running one is read up to now) |
| `GET /api/v1/servers/{id}/containers/{name}/logs?tail=200` | `{lines, truncated}`: plain text lines (`<time> <line>`), at most 1000 lines and 256 KiB (the oldest dropped first), no streaming |
| `GET /api/v1/servers/{id}/jobs`, `.../jobs/{name}/runs?limit=` | `{jobs}`, `{runs}` |
| `GET /api/v1/servers/{id}/databases` | `{databases}`: declared databases with their backup, next backup and a derived `backup_state` |
| `GET /api/v1/servers/{id}/previews`, `.../proxy` | `{previews}`, `{proxy}` |
| `GET /api/v1/projects` | the Projects view: `{projects, unreachable, read_only}` |
| `GET /api/v1/audit?limit=` | the dashboard's latest audit entries with their `actor` (default 50, at most 200) |
| `POST /api/v1/servers/{id}/apps/{app}/deploy` body `{"tag": "..."}` or `{"digest": "sha256:..."}` | `202 {deployment_id}` |
| `POST /api/v1/servers/{id}/apps/{app}/build` body empty, or `{"sha": "<40 hex>"}` | `202 {deployment_id, server_id, sha, repo}`: builds the head of the app's linked branch (or that commit) with the GitHub App, on the server that builds the app, and deploys it. `server_id` is the server that holds `deployment_id` (the build server, when the app is built elsewhere). `400` not linked or a bad SHA, `409` the agent refused (a build is running...). A token cannot change the link or the build server |
| `POST /api/v1/servers/{id}/apps/{app}/rollback` | `202 {deployment_id}` |
| `POST /api/v1/servers/{id}/jobs/{name}/run` | `202 {run_id}` |

Status codes: `401` for a missing, malformed, unknown, revoked or expired token (one body for every cause). `403` for a valid token that may not do this (scope, server). `429` with `Retry-After` for a client that failed 5 times in 15 minutes (the sign-in throttle, per client address; behind a reverse proxy set `KEELSON_TRUST_PROXY=true` or every client counts as one). `404` for an unknown server, app, container or deployment. `400` for a bad parameter or body. `502 {"error": "agent unreachable: <reason>"}` when the agent does not answer. The agent's own refusals (`400`, `404`, `409` busy) pass through with its message. `KEELSON_ALLOWED_IPS` applies to the API like to every page.

**Writes** use the signed agent calls exactly as the buttons do, with the actor `token:<name>` in the agent's audit log too. Each one is also in the dashboard's audit log (`api_deploy`, `api_build`, `api_rollback`, `api_job_run`), as is each call that a valid token was refused (`api_denied`, `403`). A `401` is counted for the throttle but not logged. `last used` and its address are written at most once a minute per token.

## Environment variables (write-only)

Each app has an **Environment variables** page (`/servers/<id>/apps/<app>/environment`, linked from the app page) to set what an app runs with, without SSH. The values live **in files on the agent** (`<data-dir>/env/<app>.<scope>.env`, mode 0600), never in this dashboard's database, and are **write-only**: once saved, a value is never sent back to the browser. The page lists the names, *Set*, when each changed, a *build* badge, and *Overrides env_file* / *Overrides env* when the managed value wins over the same name in the apps file. An older agent gets *This agent is too old to manage variables* and a link to update it, and without the server's deploy secret the list is read-only.

- **Two tabs.** *Production* is the app's own container. *Preview* (only for an app with a `previews:` template) applies to every preview of the app, which never inherits the app's `env_file`, `env` or Production variables. The effective environment is `env_file`, then `env:`, then the managed values.
- **Add, replace, delete, import.** *Add variable* takes a name and a value. *Replace* never shows the old value (leave the field empty to keep it and only change the build-time flag). *Delete* and *Remove all* ask for confirmation. *Import .env* reads a pasted or uploaded file in the browser (comments, `export`, single, double and backtick quotes, `\n` `\t` `\\` `\"` escapes in double quotes, multi-line quoted values, inline ` # comments`). A repeated name keeps its last value and is reported, and invalid names and unreadable lines are listed by line number without their content. You review the **names** before one request saves them. Names follow `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. `PATH`, `HOME`, `HOSTNAME`, `KEELSON_*` and, for an app with `port:` or `host_ports`, `PORT` (and its `port_env`) are refused. A value is at most 32 KiB without NUL, and a scope at most 200 variables and 256 KiB. The agent checks all of it again.
- **Available at build time** also passes the variable to `docker build` as a build argument for builds of that app (the classic builder: no BuildKit secrets). Such a value is **baked into the image and visible in its history**. The form says so, ticks the box by itself for `NEXT_PUBLIC_*`, `VITE_*` and `PUBLIC_*`, and warns more loudly for a name that looks like a secret. It reaches the image only when it is built again, not when the same image is redeployed.
- **Applying.** A change runs after the next deployment. The dashboard says *Saved. Not running yet: redeploy to apply* with a Deploy button prefilled with the serving tag, and the app page carries a *Variables changed since the running version* badge until then. Preview variables apply to previews deployed from then on.
- **Where values go.** They travel once, in the signed request to the agent, and are removed from any error message. They are never in the audit log, a toast, a URL or a log line. The audit log records `env_set`, `env_unset`, `env_build` and `env_delete` (and `…_failed`) with the **names** only. API tokens (`/api/v1`) and the MCP have no route or tool for variables.

## Deploying, rolling back, restarting and saving configuration

Every action says what will change before it runs, and answers with a toast linking to its result.

- **Deploy** lists the versions deployed before (the serving one marked) and shows *current → new*. **Roll back** names the version it will deploy (the newest successful deployment whose image is not the serving one). It is off, with the reason, when there is none, and absent for an app never deployed.
- **Promote** shows what the target runs now and what it will run. Into production the confirmation is styled as destructive and names the app and both versions.
- **Start and Restart** work on containers that carry the agent's `keelson.app` label, with the deploy secret (signed `POST /v1/containers/{name}/start` and `/restart`). Start is offered for a stopped container, Restart (confirmed) for a running one, and neither while a deployment of the app runs. An agent without these routes answers 404 and the dashboard says it must be updated. Attempts are audited (`container_start`, `container_restart`).
- **Saving configuration** reviews the exact changes first (secrets are never shown, only that a variable changed). A change to what is baked into the container (image, variables, command, ports, volumes, network, restart policy, logging) is not running until the next deployment. The dashboard says *Saved. Not running yet: redeploy to apply*, and the app page carries a *Config changed since the running version* badge until the next successful deployment. Domains, jobs, notifications and previews apply live. Health, drain and release settings are read at the next deployment.
- **Per-project configuration.** A project's **Configuration** tab (`/projects/<name>/config`) shows, for each server that holds the project, where its configuration lives: its own file `projects.d/<name>.yaml` or the server's shared apps file. You edit a project's own file there as YAML, with secrets as `<hidden>` and the same check, review, step-up and conflict handling as the server's Configuration page. A project still in the shared file is read-only, with *Give the project its own file*: the agent first answers what would move (nothing is written), and only your confirmation applies it. An agent that answers 404 to `GET /v1/projects` has no per-project files, and the tab asks you to update it.
- **Failed deployments** show the failed container's last output (about 200 lines, 32 KiB, kept by the agent as deployment events of level `output`) in a collapsed *Container output (last lines)* block of the deployment page. Older agents record none.

## Hardening checklist

- Sign-in needs the password, then a second factor: an authenticator code, or a passkey (which replaces both). Set `KEELSON_REQUIRE_2FA=true` once enrolled.
- Sessions are server-side: each can be listed and revoked from **Settings, Security**, goes idle after 2 hours and ends after 12. Changing how the account is protected asks for the password again.
- Failed sign-ins and second-factor attempts share one throttle (5 per 15 minutes per client) that survives restarts. Every sign-in, failure, security change and revocation is in the audit log on the Security page.
- API tokens (see above) are scoped, expire (30 days by default, 365 at most), can be limited to some servers, are stored as a hash and are shown once. Prefer `read`, and a `deploy` token limited to the servers it needs.
- Responses carry a nonce-based content security policy, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and HSTS over https.
- Restrict who can reach it with `KEELSON_ALLOWED_IPS`, or put it behind a VPN, when you can.
- **Unlocking changes.** A signed-in session can look at everything but changes nothing sensitive until it is **unlocked** (the padlock in the top bar: password, then the second factor or a recovery code; ten minutes, for that session only). Unlocking is asked for whatever makes the server run something else or reach somewhere else: creating or removing an app, job or database; an app's image, command, volumes, ports, network, environment file, release steps or build; what a job runs; a database's connection and backup destination; where alerts go; the raw editor, restoring a version, stored variables, adding or removing a server, the GitHub App, and a new second factor or passkey. Schedules, health and soak settings, domains, retention and alert thresholds do not need it, and neither do deploy, rollback and restart. Without a second factor set up, the password alone unlocks. A stolen session cookie therefore cannot rewrite the configuration or plant its own passkey.
- `GET /api/health` answers 503 with a coarse reason when the database or the master key cannot be used (it caches the answer for 5 seconds), so a monitor sees a broken dashboard. A server whose stored credential can no longer be decrypted (a wrong `KEELSON_DASHBOARD_KEY`) is shown as *unreadable* on its own card instead of breaking the whole fleet page.
- The browser never talks to an agent. The dashboard's server does, and holds the credentials.
