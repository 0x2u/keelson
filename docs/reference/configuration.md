# Configuration

The agent's desired state is a YAML **apps file**, written by you or by the dashboard through the agent's API. Unknown keys are rejected, and every problem is reported with its line. The top-level sections:

| Section | What it holds | Page |
|---|---|---|
| `registries` | Credentials for private image registries | [Deployments](./deployments.md#the-apps-file) |
| `apps` | The containers to deploy: image, environment, network, port or domains, health check, release steps, build, previews, database, source | [Deployments](./deployments.md), [Builds](./builds.md), [Previews](./previews.md) |
| `proxy` | The reverse proxy: Caddy or nginx, sites, certificates | [Reverse proxy](./proxy.md) |
| `jobs` | Scheduled work | [Scheduled jobs](./jobs.md) |
| `databases` | PostgreSQL servers to back up and restore | [Databases and backups](./databases.md) |
| `managed_postgres` | Settings of the PostgreSQL the agent can create | [Databases and backups](./databases.md#managed-postgresql) |
| `notifications` | Webhook, Telegram and heartbeat | [Notifications](./notifications.md) |
| `build_limits` | What this server accepts to build for other servers | [Builds](./builds.md#building-on-one-server-running-on-another) |

The key spellings are those of **schema v1**. A file written in the earlier spelling still loads, with a `deprecated` warning for each key that changed, and `keelson-agent config migrate` rewrites it ([Schema](../schema.md)).

## One file per project

The apps file can stay one file for the whole server, or each project can have its own file. Next to the apps file the agent reads a directory, **`projects.d/`**, of `<project>.yaml` files (`--projects-dir` or `KEELSON_PROJECTS_DIR` puts it elsewhere). Without that directory, or when it is empty, nothing changes: the configuration is the apps file, its hash is the file's hash and its versions are the file's text.

```
/etc/keelson/config/
  apps.yaml            # proxy, registries, notifications, managed_postgres: what is the server's
  projects.d/
    shop.yaml          # project "shop": its apps (with their previews), jobs and databases
    blog.yaml
```

```yaml
# projects.d/shop.yaml
apps:
  - name: shop                 # project: shop is implied by the file name
    image: ghcr.io/acme/shop
    release:
      steps: [{name: backup, backup: shop}]
jobs:
  - name: purge
    schedule: "@daily"
    http: {url: https://shop.example.com/purge, bearer: {app: shop, env: CRON_SECRET}}
databases:
  - name: shop
    host: db
    database: shop
    user: shop
    backups: {schedule: "@daily", recipients: [age1...], destinations: [{local: {dir: /var/backups}}]}
```

- **What goes where.** The apps file keeps the server-wide sections (`proxy`, `registries`, `notifications`, `managed_postgres`, `build_limits`) and may still hold apps, jobs and databases. A project file holds only `apps`, `jobs` and `databases`. A server-wide section or an unknown key in it is an error, with the file and the line. The file name is the project (`shop.yaml` is project `shop`, a name as an app's). Only `*.yaml` files are read. Files starting with a dot are ignored (the agent writes its changes through such a file). A `*.yml` file is an error, so it cannot be ignored by mistake. A project file with nothing in it is valid.
- **Membership is explicit.** `project:` is a label of an app, of a job and of a database. In a project file an entry without it takes the file's project, and one that names another project is an error (at the entry's line). In the apps file the label only groups. The backup job of a database has its database's project.
- **One configuration.** The apps file and the project files are validated together. A name is unique across all of them, a job may call an app (and a release step back up a database) written in any file, and every issue says which `file` and `line`. The configuration is **one state**:
  - Its hash covers every file.
  - A version records every file, and restoring a version puts every file back (a project file the version does not have is removed).
  - The `.force` acknowledgement holds the hash of the whole configuration (`GET /v1/config` `hash`).
  - A hand edit of any file is picked up within 5 seconds and meets the same guard.

  If any file is invalid, the state is refused as a whole and the last good one keeps running. A project is never half applied.
- **Saves go to the file that holds the entity.** `PUT /v1/config/apps/{name}` (and jobs and databases; `PUT /v1/config/previews/{app}` for an app's `previews` block) rewrites the entry where it is. A new entry labelled `project: X` goes into `projects.d/X.yaml` when that file exists, else into the apps file with its label. The files are written one after the other, atomically each, project files first. If the agent stops half-way, the state on disk is refused as a duplicate and not applied with an entry missing.
- **Moving an existing server to project files** is one command, which refuses anything that would change what runs:

```bash
keelson-agent config split --apps /etc/keelson/config/apps.yaml --project shop --dry-run   # what would move
keelson-agent config split --apps /etc/keelson/config/apps.yaml --project shop
```

From the apps file into `projects.d/shop.yaml` it moves:

- the apps labelled `shop` (an app without a label belongs to the project of its name; its previews, database and source go with it);
- the jobs and databases labelled `shop`;
- the unlabelled ones the dashboard files under it: a job whose `http.bearer.app` or `container.app` is one of the apps, and a managed database of one of them or one named by their release `backup:` step. A database that an app of another project also backs up stays, and the plan says why.

Entries labelled with another project never move. Comments move with their entries, and the rest of the apps file is re-indented. Before writing, the agent parses the result and compares it, by name, with the configuration before. Any difference other than the label of the moved entries refuses the split. `POST /v1/projects/{name}/split` does the same through the API, as one new version.

Removing a project is `DELETE /v1/projects/{name}/config`. Its file goes, and with it its apps and jobs, so the removal asks for the acknowledgement, as removing an app does. `GET /v1/jobs` and `GET /v1/databases` show each entry's `project` (its label, or its file's; absent when neither says, and the dashboard derives it).

## Checking a file and editing it with completion

**Check it before it reaches a server.** `keelson-agent config validate` loads the apps file and its project files exactly as the agent does and reports every problem with the file and line, without Docker, without a running agent and without reading a secret file, so it runs on a laptop or in CI:

```console
$ keelson-agent config validate --apps apps.yaml
apps.yaml:5: error: unknown key "helth_path" in apps[web]
apps.yaml:6: error: app "web": duplicate name (first defined in apps.yaml, line 2)
projects.d/shop.yaml:2: error: app "shop": port "80" must be [hostip:]hostport:containerport[/proto]
apps.yaml:8: warning: keep_images: 0 is deprecated: 0 meant the default, leave the key out (apps[web].keep_images)
invalid: 3 errors, 1 warning
```

The exit status is 0 for a valid configuration (warnings do not change it, `--strict` makes them fail), 1 for an invalid one and 2 for a usage error or a file that cannot be read. `--format github` prints workflow annotations (`::error file=...,line=...::`), `--format json` a machine-readable list. What it cannot see is what only the server has: that a secret file or an `env_file` exists, that a port is free, that Docker or Caddy answer. `keelson-agent doctor` looks at those on the server itself.

**Completion and hover text in your editor.** The structure of the files is published as JSON Schema, generated from the same definitions the agent uses, with the documentation of each key as its hover text: [`apps.schema.json`](../json-schema/apps.schema.json) for the apps file and [`project.schema.json`](../json-schema/project.schema.json) for a file of `projects.d/`. With the YAML language server (VS Code's Red Hat YAML extension, Neovim, JetBrains), start the file with:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/0x2u/keelson/main/docs/json-schema/apps.schema.json
```

The schema describes keys and types; the rules that need the whole configuration (unique names, a job that finds its app, a free port) are `config validate`'s. The earlier spellings that still load, with a warning, are not in it.

## Editing the configuration while the agent runs

You can change the apps file without restarting the agent, through the API (which is what the dashboard uses) or by editing the file by hand. Both end the same way. The agent validates the whole document, then each part of the agent **applies it or refuses it before anything changes**, so a change is applied everywhere or nowhere.

- **Validation lists every problem**, one per broken app, job or section plus every unknown key, each with its line, and writes nothing.
- **Secrets never leave the agent.** Environment values (of apps and of previews templates), job HTTP headers and bodies, webhook URLs and the heartbeat URL are replaced by `<hidden>` in everything the API returns. Sending `<hidden>` back keeps the stored value, and a new value replaces it. The dashboard shows such fields as "set".
- **The file is written atomically** and keeps its mode. Saves of a whole document keep the text exactly as written, comments and blank lines included (only the secrets are swapped back). Saves of one app, one job or the notifications section rewrite the file through the YAML tree, which keeps comments but normalizes blank lines and indentation.
- **Every state is a version** (the last 100), with its source (`startup`, `api`, `file`, `restore`), who sent it and a comment. You can view a version (secrets hidden) and restore it, which writes it as a new version.
- **Edits are checked against the version they were based on** (`base_hash`). If the file changed since, the change is refused with the current hash instead of overwriting someone else's work.
- **Some changes need an explicit confirmation** (`force: true`):
  - removing an app (its container keeps running but is no longer managed);
  - removing an app's `previews` block (its live preview environments are removed);
  - removing a job, or a database that has a backup (which removes its backup job);
  - changing the proxy section.
- **A change that cannot be applied now is refused whole.** Removing an app while it is being deployed, or changing the proxy during any deployment, answers `busy`. A new notifications section is built first, so a mistyped secret path is refused instead of applied.
- **Hand edits are picked up within 5 seconds.** An invalid edit is reported (`GET /v1/config` shows the error) and ignored, and the agent keeps running the last good configuration until the file is valid again. An edit that has to wait for a deployment is applied when it finishes.
- **The apps file must be writable by the agent**, with its directory (the new file is written beside it and renamed over it). A read-only file only disables saving through the API.

Some things are not hot-reloadable: the listening address, TLS, secrets and the data directory (these are flags, not configuration). Rotating the content of a secret file such as a Telegram token needs a change to the notifications section, or a restart.

| Route | Auth | Description |
|---|---|---|
| `GET /v1/config` | read token | `{content, hash, modified_at, model, applied_hash, files?, error?}`: the apps file with secrets hidden, the **configuration's** hash (the apps file's own when there are no project files) and the hash of what runs now, the parsed model (the apps file's, with the apps, jobs, databases and previews of every project file added, each of a project file with its `project` filled in), and `files`: `[{path, project, hash, modified_at}]`, the apps file first (`project: ""`). |
| `POST /v1/config/validate` | signature | `{content}` -> `{ok, issues}`: errors and warnings, no write. |
| `PUT /v1/config` | signature | `{content, base_hash, comment?, force?}` -> `{hash, version, issues}`, or `400 invalid`, `409 changed`, `409 needs_acknowledgement`, `409 busy`. `content` is the apps file's text; it is validated together with the project files. |
| `PUT` / `DELETE /v1/config/apps/{name}`, `.../jobs/{name}`, `.../databases/{name}`, `.../previews/{app}` | signature | Create, replace or remove one entity: `{app\|job\|database\|preview, base_hash, ...}`. Same answers. The entity is written **in the file that holds it**; a new one with `project: X` goes into `projects.d/X.yaml` when that file exists, else into the apps file (label kept); a previews template goes where its app is. An entity of a project file cannot be given another `project`. |
| `PUT /v1/config/notifications` | signature | `{notifications: {...} \| null, base_hash, ...}`. |
| `GET /v1/config/versions?limit=` | read token | The history, newest first. |
| `GET /v1/config/versions/{id}` | read token | One version with its text (secrets hidden): `{..., content, files?}`, `content` being the apps file's text and `files` (only when the version has project files) `[{path, project, hash, content}]`. |
| `POST /v1/config/versions/{id}/restore` | signature | `{base_hash, force?}`: puts that version back as a new one, **every file of it**: a project file the version does not have is removed (its apps leave: `force`). |
| `GET /v1/projects` | read token | The project files, `[{name, path, hash, applied_hash, modified_at, apps, jobs, databases, previews}]` (`[]` without any). |
| `GET /v1/projects/{name}/config` | read token | `{project, path, content, hash, applied_hash, config_hash, modified_at, model, error?}`: that project's file with secrets hidden. `hash` is the file's (what the next `PUT` is based on), `config_hash` the whole configuration's. `404` when there is no such file. |
| `POST /v1/projects/{name}/config/validate` | signature | `{content}` -> `{ok, issues}`: the file checked in the context of the others (names unique across files, a job's app anywhere), no write. |
| `PUT /v1/projects/{name}/config` | signature | `{content, base_hash?, comment?, force?}` -> `{hash, config_hash, version, issues}`: writes the file, **creating it** when it does not exist (`base_hash` is the file's hash; none checks nothing). Hidden secrets are kept. Same refusals as `PUT /v1/config`; an issue names its `file` and `line`. |
| `DELETE /v1/projects/{name}/config` | signature | `{base_hash?, comment?, force?}` -> `{hash: "", config_hash, version, issues}`: removes the file. Its apps and jobs leave the configuration, so `409 needs_acknowledgement` until `force: true`, as for any removal. `404` when there is no such file. |
| `POST /v1/projects/{name}/split` | signature | `{base_hash?, comment?, force?, dry_run?}`: moves what belongs to the project out of the apps file into `projects.d/<name>.yaml`, as one new version -> `{dry_run, hash, file_hash, version, issues, plan: {project, file, apps, jobs, databases, previews, kept}}`. With `dry_run` only the plan is answered. Refused (`400 invalid`) when the file exists, nothing belongs to the project, or the result would not run exactly what runs now. |
| `GET /v1/audit?limit=&before=` | read token | The audit log, newest first. |
| `GET /v1/stats/history?container=&range=` | read token | Recorded CPU and memory of a container, or of the app it serves (so the history follows the app across deployments, and the two versions of a switch are added up). `range` is a duration from `1m` to `24h` (default `1h`); a range longer than 2 h is averaged into about 240 points of `step_seconds` each, every point keeping its peak. Only with `--apps`. |
| `GET /v1/stats/host?range=` | read token | Recorded load, memory and disk of the machine: `{cpus, step_seconds, points: [{time, load, load_max, mem_percent, mem_percent_max, disk_percent, disk_percent_max}]}`. `range` is read as for `stats/history`. Memory and disk are in percent used (memory without what is reclaimable), load is the 1 minute average to read against `cpus`; each value is the average over the point with its peak, and is left out of a point when the machine does not expose it. `404` without `--apps`. |
| `GET /v1/apps/{app}/availability?range=` | read token | How much of the range the app was up, as the app watcher judged it: `{app, range, from, to, since, covered_seconds, down_seconds, uptime_percent, incidents: [{start, end, duration_seconds}]}`. `range` is `24h` (default), `7d` or `30d`. `since` is where the record starts, later than `from` when the agent has watched the app for less than the range, and `uptime_percent` is computed over that part only; both are `null` for an app that has not been judged yet. `incidents` are the ones that touch the range, newest first, at most 50; `end` is `null` while one lasts. `404` without `--apps`. |

**The stats history** is a ring buffer in the agent's database. Every 30 seconds each running container is sampled once (CPU in percent of one core, memory without reclaimable cache, like `docker stats`), and what is older than 24 hours is deleted. That is about 2,900 rows a day per container. Jobs and release steps are one-offs and are recorded under their own names. A read-only agent (no `--apps`) has no database and records nothing.

**The host history** is recorded in the same cycle: the 1 minute load, memory used and disk used of the filesystem that holds the agent's data directory (`/` when that cannot be measured). It is pruned with the same 24 hours, and is recorded even while the Docker engine does not answer.

**The availability record** keeps when each app went down and when it came back, for 30 days. It uses the rule of the `app.down` alert: an app is down after three observations 15 seconds apart say so, and back at the first healthy one. While a deployment replaces the app or its health check is still starting, it is neither. The record runs whether or not notifications are configured, but it does not apply the alert cooldown, so an app that is down is recorded as down even when its alert was held back. The agent only knows what it watched. An app is recorded from the first time it was judged, and an incident that was open when the agent stopped stays open until the app is seen healthy again.

**The audit log** records every authenticated request that changes something: deployments, rollbacks, preview deployments and removals, job runs, configuration changes, and changes to stored variables (key names only). Each entry has its time, the sender's label (`X-Keelson-Actor`, unsigned, so it labels and does not authenticate), the peer address, the route's name, the HTTP status and a detail (the app, job or new hash). Refused changes appear too, with their status. Requests with a bad signature and validation calls do not, so unauthenticated traffic cannot fill the log. The last 5000 entries are kept.

## Hand edits and start-up

- **A hand edit of the apps file meets the same guard as the dashboard and the API.** A file that would drop or orphan a running app, or change the proxy in a way the guard refuses, is **not applied**. The running configuration stays, and the reason is in `GET /v1/config` (`error`) and, once, in the log. To confirm that is what you want, write the new file's SHA-256 (the message gives it) into `<apps file>.force`. That one version is then applied and the marker is removed, and an edit after it asks again.
- **A bad file does not make the agent loop.** If the apps file is invalid at start (or names a secret file that is gone), the agent starts on the newest recorded version that loads, says so loudly (`using version N: the file on disk is invalid because ...`), and applies the file once it is fixed. With no usable version it exits.
- **The agent's own state is copied.** See [Disk housekeeping](./deployments.md#disk-housekeeping) for the copies of `agent.db` and what happens when it is lost.
