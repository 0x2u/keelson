# Installing and connecting servers

A server is a machine with Docker and an agent. The dashboard reaches the agent in one of two ways:

- **The agent connects out** (the default). One command on the server installs the agent and opens a single outbound HTTPS connection to the dashboard. There is no inbound port, certificate, firewall rule or SSH login typed into a web form. See [Agents that connect out](./relay.md).
- **The dashboard reaches the agent** (direct). The agent listens on a private or public address and the dashboard connects to it over mutual TLS. This page covers that case: installing the agent, pairing it with a one-time code, removing it, and the other ways to add such a server in the dashboard.

Both run the same agent. Apps, jobs, databases, previews, proxy and configuration editing behave the same, and only the transport differs.

## Connecting a server (default)

*Servers → Add server → Connect with one command* shows a command to run on a Linux server (systemd, amd64 or arm64, Docker installed):

```bash
curl -fsSL https://<dashboard>/install | sudo sh -s -- --code <one-time code> [--name NAME]
```

Details, upgrade and uninstall are in [Agents that connect out](./relay.md#connecting-a-server-with-one-command).

## Direct connection: installing the agent

```bash
scripts/build-agent.sh                         # static binaries for linux and macOS, amd64 and arm64, with SHA256SUMS, in dist/agent
sudo ./keelson-agent install --host 203.0.113.10 [--name NAME] [--listen 0.0.0.0:7443] [--nginx] [--allow-from IP|auto] > bundle.json
sudo ./keelson-agent install --upgrade      # replace the installed agent with this binary, keeping how it was set up
sudo keelson-agent enroll-code [--ttl 15m]  # prints a one-time enrolment string for the dashboard's "Enrol with a code" (see below)
sudo keelson-agent uninstall [--purge [--purge-operator-files]] [--dry-run]   # prints what it did (or would do) as JSON; the apps keep running
```

`install` needs root, Docker and systemd. It does the following, and it is the only thing the dashboard asks a server to do over SSH:

| What | Detail |
|---|---|
| Account | A system user `keelson`, no login, member of the `docker` group. **Docker group membership is root-equivalent on the host**, so treat the agent as root. |
| Files | `/usr/local/bin/keelson-agent`; `/etc/keelson` (secrets: API token and deploy secret, mode 0640, group `keelson`); `/etc/keelson/config/apps.yaml` (owned by `keelson`: the agent rewrites it when you edit configuration); `/etc/keelson/enroll` (pending one-time enrolment codes, `root:keelson 0770`, see below); `/var/lib/keelson` (database). |
| Certificates | A certificate authority **per server** (ECDSA P-256, 10 years), a server certificate for the `--host` names (5 years) and a client certificate for the dashboard (5 years). The CA key stays in `/etc/keelson/tls/ca.key`, readable by root only, so the agent, which faces the network, never holds it. The agent requires a client certificate signed by that CA (TLS 1.3). |
| Service | `keelson-agent.service`: restarts on failure, `ProtectSystem=full`, `PrivateTmp`, `NoNewPrivileges` (off with `--nginx`, see below), writes allowed only to the config, enrolment-code and data directories. |
| `--nginx` | A directory `/etc/nginx/keelson` owned by the agent, and a sudoers rule that lets it run exactly `systemctl reload nginx` and `nginx -t`. It prints the line to add to nginx and the `proxy:` section to use. |
| `--allow-from` | With ufw active, opens the agent's port for that address only (`auto` takes the address of the SSH session). Without ufw it says so, and you open the port yourself. |

It prints the **connection bundle** as JSON on standard output (progress goes to standard error): the agent's URL, token, deploy secret, CA certificate and the client certificate and key. The client key exists only in that output. Keep it as secret as the token, and delete the file once the dashboard has it.

Re-running `install` upgrades the agent: the binary and unit are replaced and the service restarted. If the new version does not answer health checks, the previous binary, unit and settings are put back. A re-run with fewer flags than the first time (no `--nginx`, say) would quietly change the unit, so for an upgrade use **`sudo ./keelson-agent install --upgrade`**. It takes the listen address, host names, name and nginx setting the installation remembers (`/etc/keelson/install.json`), refuses a server where nothing is installed, and keeps the apps file, secrets and certificate authority. Running containers are not touched. `uninstall` removes the service and binary and keeps the configuration and data. `--purge` removes those too, along with the firewall rule it added, the sudoers rule and the account.

Limits: certificates expire after 5 years and are not renewed automatically (re-running `install` reissues the server certificate when it is within 60 days of expiry and issues a new client certificate). Only Linux with systemd is supported, and the installer does not install Docker.

### Enrolling the dashboard with a one-time code

Instead of copying a token, a deploy secret, the CA certificate, a client certificate and a client key into the dashboard, run one command on the server:

```bash
sudo keelson-agent enroll-code [--ttl 15m] [--url https://203.0.113.10:7443]
```

It prints one line, the **enrolment string** (`kse1.` followed by base64url, no padding, of `{"u": <URL>, "fp": <SHA-256 of the agent's server certificate>, "c": <code>}`), and nothing else on standard output. When the code expires goes to standard error. Paste the string into the dashboard's *Add server → Enrol with a code*. The URL and the fingerprint default to what `install` recorded (`/etc/keelson/install.json`) and to `/etc/keelson/tls/server.crt`. `--url` overrides the address. `install` ends the same way: a fresh install puts an `enrolment` string (and `enrolment_expires`) in the bundle JSON and prints it on standard error (`--no-enrolment-code` skips it; `install --upgrade` never makes one, and the bundle's other fields are unchanged).

The code is 24 random bytes (192 bits), **works once** and lives 15 minutes by default (`--ttl`, at most 24 h). The dashboard first connects to the URL and compares the SHA-256 of the certificate the agent presents with `fp`, so it sends the code only to an agent whose certificate it was told to expect. It then calls `POST /v1/enroll` with `{"code": "..."}`. That call needs neither a client certificate nor the token and answers `200 {"ca_pem", "client_cert_pem", "client_key_pem", "token", "deploy_secret"}`. The deploy secret is empty when the agent has none, and the dashboard server is then read-only, as with the other ways in. Errors:

- `400`: malformed body.
- `403 {"error": "invalid or expired code"}`: the **same answer** for an unknown, a used and an expired code.
- `404`: enrolment is not enabled on this agent.
- `429` with `Retry-After`: after 5 failed attempts in a minute, counted **for the whole agent, not per address**. The agent may sit behind a proxy that shows one address for everybody. The cost is that someone who can reach the port can keep enrolment locked by failing five times a minute, which blocks pairing and nothing else. While limited, even a right code is refused.

Responses are `Cache-Control: no-store`.

**When it is on.** Enrolment is enabled when the agent runs with mutual TLS (`--tls-client-ca`) and an apps file (`--apps`, because redeemed codes are recorded in the agent's database), and `--enroll-dir` (`KEELSON_ENROLL_DIR`, default `/etc/keelson/enroll`) is not empty. `--enroll-dir ""` turns it off. The agent's own log says which. An agent started without mutual TLS answers `POST /v1/enroll` with `404`. An agent with mutual TLS but no enrolment (one from before this feature, or `--enroll-dir ""`) insists on a client certificate in the handshake and hangs up on the dashboard before any request. The dashboard says so and points at `sudo keelson-agent install --upgrade` or the *Existing agent* form.

**The TLS handshake.** With enrolment on, the listener asks for a client certificate but does not insist on one (`VerifyClientCertIfGiven`), because a dashboard that has not been paired yet has none. A certificate that is presented must still be signed by the agent's CA, otherwise the handshake fails. To keep mutual TLS as strict as it is without enrolment, a gate runs in front of everything else. Whenever mutual TLS is configured, **every** request without a verified client certificate, whatever its path or method (unknown paths included), is answered `401 {"error": "client certificate required"}` before any handler runs, except `POST /v1/enroll`. Tests cover this by walking every route registered in the source with every method, over a real TLS handshake. Without enrolment the listener keeps `RequireAndVerifyClientCert`, so the handshake itself needs the certificate.

**Where the client certificate comes from.** The CA key is `root:root 0600` and the agent runs as the unprivileged `keelson` account, so the agent **cannot sign** certificates at run time, and enrolment does not change that. `enroll-code` runs as root. When it creates the code it signs the dashboard's client certificate (the same call `install` makes: CN `keelson-dashboard`, client authentication only, 5 years) and leaves the certificate and key in `/etc/keelson/enroll/<SHA-256 of the code>.json` (owner `root`, group `keelson`, mode `0640`). The agent only reads that file and deletes it: when the code is redeemed, when it is tried after its expiry, and in a sweep every minute (and at start). The directory is `root:keelson 0770` (and writable in the unit's `ReadWritePaths`) because deleting a file takes write access to its directory. It is not sticky, which would stop the agent from deleting files root created. The code itself is never stored: not in the file, not in its name, not in SQLite, the log or the audit log. The file name is the SHA-256 of the code, and the agent compares what the file says about itself with it in constant time.

The trade-off: for up to the code's lifetime, an unredeemed client key sits on disk, readable by root and the `keelson` account. That account already holds the token and the deploy secret and is root-equivalent through the Docker group. The alternative, where the agent signs when the code is redeemed, would need the CA key readable by the agent. The key is not encrypted at rest. It is as sensitive as the token next to it, and encrypting it would need a key the agent can also read. Keep `--ttl` short. A redemption inserts the code's hash in the agent's database **before** anything is read or returned, and the primary key lets exactly one of any number of concurrent redemptions through, so a file that could not be deleted still cannot be redeemed twice. Redeemed hashes are forgotten once the code would have expired anyway. The audit log gets an `enroll` entry with the first 12 characters of the code's hash and the caller's address, for a redemption and for a refused used or expired code. A plain wrong guess is not recorded, because anyone could fill the log with them.

## Removing the agent

`sudo keelson-agent uninstall` (or **Server settings → Agent → Uninstall the agent** in the dashboard, over SSH like the install) removes the agent **without touching what it ran**:

- The apps' containers are never stopped or removed. They keep serving with their restart policy and are just no longer managed. The report lists them.
- The agent is stopped first. If it cannot be stopped (or is still active after the stop), **nothing is removed**, because a unit that restarts a deleted program in a loop is worse than the agent.
- Without `--purge` the apps file, secrets, certificates, history and account stay (`/etc/keelson`, `/var/lib/keelson`), so a later install picks up where this one stopped. With `--purge` they go too, with the sudoers rule and the account.
- With `--purge`, `/etc/nginx/keelson` is **kept while any nginx configuration still refers to one of its upstreams** (`proxy_pass http://keelson_<app>`). Deleting it would make the next nginx reload (a certificate renewal, any change) fail with the site down. It is then handed to root, since the account that owned it is removed. When nothing refers to it, it is removed.
- `--purge` destroys some things you may care about. The report and `--dry-run` list them (names, counts and sizes only, never contents). They are the managed PostgreSQL's superuser password file and every role password file under `/var/lib/keelson/postgres`, and the local backups under `/var/lib/keelson/backups`. Without those password files the managed PostgreSQL data cannot be used or recovered. The backups are deleted with the data directory, so copy them away first if you want to keep them. Nothing is removed from Docker (the PostgreSQL container and its volume stay).
- `--purge` **keeps operator-added files in `/etc/keelson`**: anything the installer did not write, such as `db-*` password files, a `telegram-token`, an env file or any secret the apps file names. The installer's own files (apps file, token, deploy secret, certificate authority and server certificate, `install.json`, enrolment codes) are deleted. The others stay (handed to root, since the account is removed) and the report lists each under "kept: pass --purge-operator-files to delete". Add `--purge-operator-files` to delete them too. The flag is an error without `--purge`. Keeping them is not a failure: the other steps run and the exit status is unchanged.
- A ufw rule is removed only if it still carries the comment the installer gave it (`keelson-agent`), and only for the address the install recorded. The installer does not record a rule that already existed, so a rule you wrote yourself is never deleted.
- After the agent has stopped, a failing step does not prevent the others. Every problem is listed in the report (`problems`) and the exit status is non-zero. Running it again, or on a server without the agent, is harmless.
- `--dry-run` changes nothing and prints what would be removed and what would stay.

In the dashboard, the wizard logs in once (host key confirmed first, the login never stored) and shows what would be removed and what would stay for both choices. It warns when the agent is deploying or running a job, because stopping it would leave a deployment half done, and asks you to type the server's name. Forgetting the server in the dashboard is the last step, after you have read the result. It is recorded in the dashboard's audit log.

## Other ways to add a server

*Servers → Add server* leads with *Connect with one command*. The *Advanced* section holds the ways below. Use them to reach an agent from the dashboard (SSH, a code, an address) when the server may open a port and the dashboard may hold its certificate. *A computer that connects* is a build machine ([relay](./relay.md#a-computer-that-connects-out-keelson-agent-connect)).

1. **Install over SSH.** You give the address, the SSH port, a user and a key (or a password). The dashboard first reads the server's SSH host key **without logging in** and asks you to confirm its fingerprint, so no credential is sent to a server you have not recognised. Then it logs in, uploads its own agent binary (checked by SHA-256 on the server), runs the installer, checks the agent over mutual TLS and saves the server. **The SSH login is used for that one request and never stored.** Running it again on the same server is safe: secrets and the certificate authority are kept, a new client certificate is issued, and an upgrade that does not start is rolled back to the previous version.
2. **Enrol with a code**, for servers you can reach but do not want to give SSH access to, without copying five secrets. On the server, as root, run `sudo keelson-agent enroll-code`. It prints one line (`kse1.…`, valid 15 minutes, one use). Paste it in the second tab. The dashboard connects to the address in the line over TLS 1.3 and checks that the certificate the agent presents has the SHA-256 fingerprint in the line **before sending the code**. It then redeems the code, checks that the agent answers with what it received (mutual TLS and token) and saves the server with its token, deploy secret, CA, client certificate and key (encrypted at rest). A link `…/servers/new?enrol=kse1.…` opens the tab with the field filled in, and never submits by itself. The line is not stored. Errors are explicit: fingerprint mismatch (nothing is sent), expired or used code, enrolment not enabled on the agent (it needs mutual TLS), too many attempts.
3. **Run it yourself**, for servers you do not want to give SSH access to: download the binary, copy it over, run `sudo ./keelson-agent install --host ADDRESS > bundle.json`, open the port, paste the bundle.
4. **Existing agent**: its URL and token. Optional inputs are the deploy secret (without it the server is read-only in the dashboard, with no deploy and no rollback), a CA certificate, and a client certificate and key for mutual TLS.
5. **Import a file**, to register several servers at once (or again after resetting the dashboard). Choose a JSON file or paste it; see `dashboard/servers.example.json`:

   ```json
   { "servers": [
       { "name": "local", "url": "http://127.0.0.1:7070", "token": "…" },
       { "name": "vps", "ssh": { "host": "203.0.113.7", "port": 22, "user": "debian" } } ] }
   ```

   An entry with a `url` is an agent that already runs (optional `deploy_secret`, `ca_cert`, `client_cert`, `client_key`). It is checked before it is saved, as for an existing agent, and one that does not answer is left out unless you tick *Keep agents that do not answer yet*. An entry with an `ssh` section is a server with no agent yet. A file cannot hold the confirmation of a host key or an SSH login, so the result lists it with an *Install* button that opens the installer with the address, port, user and name filled in. A name that already exists is never overwritten, and a misspelt key is an error, not a dropped setting. The file holds tokens. `*.local.json` is git-ignored, so `dashboard/servers.local.json` is the place for yours.

   For a `local` entry the agent must be running, or the import leaves it out (unless you tick *Keep agents that do not answer yet*). `scripts/local-agent.sh` starts a read-only one with the address and token from that file.

Whichever way you use, the same command installs the agent and the dashboard receives the same bundle (see [Direct connection](#direct-connection-installing-the-agent)).

## Updating an agent

A server that connects out is updated with `curl … | sudo sh -s -- --upgrade --code <fresh code>` ([relay](./relay.md#connecting-a-server-with-one-command)).

For a server the dashboard reaches, the dashboard knows the version of the agent it carries (the `VERSION` file next to the binaries, written by `scripts/build-agent.sh` and by the image build) and the version each server reports. When they differ, the server's header shows *Update available*, and *Server settings → Agent* shows both versions. *Update the agent* asks for the SSH login again (never stored, host key confirmed first, like the install), uploads the carried binary, runs `install --upgrade` and stores the fresh client certificate. Versions are `git describe` strings with no order the dashboard can rely on, so it says "different", not "newer". You know which way the update goes.
