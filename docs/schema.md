# Configuration schema v1 and upgrading

The agent's [apps file](./reference/configuration.md) is versioned by its spelling. **Schema v1** is what every page of this documentation uses. Files written before v1 still load, so an upgrade never takes a server down. This page lists what changed, how to rewrite a file, and how to check that a schema change does not change what a server runs.

## What v1 changed

| Area | Before | Schema v1 |
|---|---|---|
| Fixed port mappings | `ports: [...]` | `publish: [...]` (only for a `replace` deployment) |
| Ports of an app on the host network | `host_ports: [3000, 3001]` and `port_env: PORT` | `port: {host: [3000, 3001], env: PORT}` |
| Stop timeout | `stop_timeout: 30` (seconds) | `stop_timeout: 30s` (a duration) |
| A zero meaning "the default" (`health_timeout`, `stable_after`, `keep_images`, `log.max_file`, build `timeout`, `cpus`, `memory`, `max_source`, step and job `timeout`, `alert_after`, backup `timeout`, `keep`, `keep_pre_deploy`, `previews.ttl`, `previews.max`, `notifications.disk_alert_percent`, `memory_alert_percent`, `heartbeat.every`, and the settings of the managed PostgreSQL) | `key: 0` | leave the key out |
| An empty list of events | `events: []` (sent the default events) | leave `events` out |
| Managed PostgreSQL settings | `postgres:` | `managed_postgres:` |
| Command of a release step or a job, on the host | `run: [...]` | `host: [...]` |
| Command of a release step, in a container | `command: [...]` and `image: ...` | `container: {command: [...], image: ...}` |
| Backups of a database | `backup: {...}` | `backups: {...}` |
| Where backups go | `destination: {...}` | `destinations: [{...}]`, a list |
| Previews of an app | a top-level `previews:` list whose entries name an `app:` | a `previews:` block inside the app |
| A database the agent creates for an app | an entry of `databases:` with `managed: true`, `app:` and `env_key:` | a `database:` block inside the app |
| Builder apps | an app with `build: {only: true}` | removed: any server builds for another through `build_limits` ([Builds](./reference/builds.md#building-on-one-server-running-on-another)) |
| Strategy of a deployment | inferred from `domains` | `deploy: {strategy: switch\|replace}`, still inferred when left out |
| Repository of an app | kept by the dashboard | `source: {repo, branch, ...}` ([Builds](./reference/builds.md#linking-an-app-to-its-repository)) |

One default changed too: an app with no `restart` now runs with `unless-stopped` (it was `no`), so it comes back after a reboot or a crash.

## Upgrading a file

The loader reads the earlier spelling and reports a `deprecated` warning for every key that has a new one. Nothing else changes. To rewrite the files:

```bash
keelson-agent config migrate --apps /etc/keelson/config/apps.yaml --dry-run   # what would change, nothing written
keelson-agent config migrate --apps /etc/keelson/config/apps.yaml
```

- It handles the apps file and the project files of `projects.d/` together. It edits the YAML in place (comments, quoting and anchors stay as written) and keeps the original of every file it changes as `<file>.pre-v1` (`--no-backup` skips the copy).
- It writes only when the result loads without a deprecation **and runs exactly what the files run now** (it compares the two with `config dump`, below). Otherwise it refuses and says why.
- What it cannot move by itself is listed as *left as it is*. In that case it exits with status 3 and writes nothing. `--allow-leftovers` migrates the rest and leaves those keys as they are.
- `--pin-legacy-defaults` writes `restart: "no"` on the apps that had no `restart`, which is what they ran with before the default changed.
- `--drop-builders` removes builder apps (`build.only`) and writes the `build_limits` that cover them. A builder app still loads without it, with a warning, but the dashboard no longer uses it. After it, give each app *Source → Build on* that server again.
- Exit status: 0 done or nothing to migrate, 1 refused, 2 usage, 3 leftovers.

A running agent applies the migrated file within seconds as a new configuration version, like any hand edit ([Configuration](./reference/configuration.md#editing-the-configuration-while-the-agent-runs)).

## The safety net: `keelson-agent config dump`

Apps files carry real traffic. A schema change (a renamed key, a new default, a loader rewrite) must not change what a file runs, except for the deltas listed below. To check that, compare what a configuration makes the agent run, before and after, using a dump that does not depend on how the YAML is spelled.

```sh
keelson-agent config dump --apps apps.yaml [--projects-dir DIR] > runtime.json
```

It reads the apps file and its project files (`projects.d` next to the apps file, unless `--projects-dir` or `KEELSON_PROJECTS_DIR` says otherwise), validates them like the agent does, and prints the effective runtime as JSON. It needs no running agent, no Docker and no secret file. Nothing but the YAML files is read.

The dump is independent of the YAML:

- Its keys are its own (`restart_policy`, `routing.proxy_container_port`, `stop_timeout_seconds`, `steps[].kind`...), never the YAML keys, so renaming a YAML key does not change a byte of it. Only a change to the code that builds the dump (`agent/internal/config/dump.go`) changes its layout, and that is reviewed as a change of the baseline itself.
- Every default is resolved. A setting left out and the same setting written at its default give the same bytes.
- Durations are seconds, sizes are bytes, a Docker restart policy is what Docker gets (`""` is `no`), a published port is parsed, and a backup with one destination is a list of one.
- Lists whose order has no meaning (apps, jobs, databases, previews, notification events, managed databases of an app) are sorted by name. Lists where order matters (release steps, verify paths, domains, proxy sites, commands) keep the order of the file.
- The text of the files plays no part: no hash, no line, no file name, no comment, no order of keys.

Per app, the dump covers:

- labels, image, environment variable names, command, volumes, network, restart policy;
- stop, health and stable timeouts, drain and soak, verify paths, `keep_images`, log options;
- routing: domains, published ports, the container port the proxy forwards to, the two host ports and their variable, the health path;
- release steps by kind with their timeouts;
- the build block with its defaults and the network it really runs on;
- the extra networks it joins and its managed databases;
- the instance a previews template synthesizes for pull request 1.

It also covers jobs (including the backup jobs synthesized from the databases) by kind, databases with their backups and every destination, registries, the proxy (Caddy or nginx, sites, certificates), notifications with the events really sent, and the effective settings of the managed PostgreSQL.

**Secrets.** The dump never prints a secret. These are replaced by `<hidden>`:

- the values of `env` (apps and previews);
- the headers and the body of a job's HTTP call, and the query of a job's URL;
- the webhook and heartbeat URLs;
- the value of a build argument or of a command-line argument named like a secret (token, secret, passw, key, credential, the same rule as the redaction of the documents the API sends).

Names stay, so an added or lost variable still shows. Files that hold a secret (`password_file`, `secret_key_file`, `bot_token_file`, `secret_file`) are printed as paths and never read. So the dump shows that the same variables exist, not that their values are the same. A change of the loader cannot change a value it does not read, and the migration copies values as nodes.

### Checking a real server

Never test on the live files. Work on a copy.

1. Copy the configuration off the server as it is: `apps.yaml` and the whole `projects.d/` directory, nothing else (the dump needs no secret). Keep the copy untouched.

   ```sh
   mkdir -p baseline/vps-1 && scp vps-1:/etc/keelson/config/apps.yaml baseline/vps-1/
   scp -r vps-1:/etc/keelson/config/projects.d baseline/vps-1/ 2>/dev/null || true
   ```

2. With the agent binary that accepts the current schema, dump the copy: `keelson-agent config dump --apps baseline/vps-1/apps.yaml > baseline/vps-1.before.json`.
3. Work on a second copy (`cp -r baseline/vps-1 work/vps-1`). Load it with the new binary, or migrate it (`keelson-agent config migrate`), then dump it again: `keelson-agent config dump --apps work/vps-1/apps.yaml > baseline/vps-1.after.json`.
4. Compare: `diff -u baseline/vps-1.before.json baseline/vps-1.after.json`. The diff must be empty, except for the allowed deltas below, each of which you can account for line by line. Anything else is a bug in the change, not in the file. Stop and report it before touching the server.
5. Only then upgrade the server. Afterwards dump the live file once more and compare it with the baseline again. The running agent must have loaded what the dump says (`applied_hash` equal to the hash on disk, no `error` in `GET /v1/config`).

### Allowed deltas

These are the intended differences between the earlier schema and v1. A change that makes the dump of an earlier file differ in any other way is a regression. Add a line here, with the change that makes it, before regenerating a golden file.

| Delta | Where it shows | Why |
|---|---|---|
| `restart_policy`: `no` becomes `unless-stopped` for an app with no `restart` | `apps[].restart_policy` | The new default. `config migrate --pin-legacy-defaults` writes `restart: "no"` and keeps the old value. |

### What the dump does not cover

- Values of secrets, and the content of any file the configuration points at.
- What the dashboard keeps in its own database (source links, build servers, environments of variables).
- The agent's runtime state (containers, deployments, the instances of previews that exist).
- The text of the files: comments, key order and formatting are not part of the runtime. Compare the files themselves (a `diff` of the YAML, or the `.pre-v1` copies a migration keeps) when that matters.

### The baseline in the repository

`agent/internal/config/testdata/legacy/` holds apps files in the earlier spelling and, next to each, the `*.runtime.json` that `config dump` printed for it. It has a copy of every `docs/examples/*.apps.yaml` as it was before the schema change. It also has `coverage-server.apps.yaml` with `coverage-server.projects.d/`, a fixture that adds what no example has: the managed PostgreSQL and managed databases, every kind of backup destination, every kind of job and proxy site, the notification channels and a project file. `TestLegacyExamplesRuntimeBaseline` dumps every one of them again and compares byte for byte. The files are never edited. The golden files are regenerated, in the same commit as the change that explains the difference, with:

```sh
go test ./internal/config -run TestLegacyExamplesRuntimeBaseline -update
```

`TestRuntimeJSONHidesEverySecretAndKeepsTheNames` and `TestRuntimeJSONIsDeterministicAndIgnoresOrderAndSpelling` pin the redaction and the determinism of the dump.
