# Databases and backups

Keelson supports PostgreSQL only. A database is either declared (an existing server that you run) or managed (the agent creates the server, the database and the role for an app). Both get the same scheduled, encrypted, verified backups and the same guided restore.

## Declaring a database

If you declare an existing PostgreSQL server (the one next to your apps, or a hosted one), the agent shows its version and size, backs it up on a schedule and restores a backup on request. Keelson does not create or change a database you declare here. To have the agent create the server, the database and the role for an app, see [Managed PostgreSQL](#managed-postgresql) below.

```yaml
databases:
  - name: shop                         # ^[a-z0-9][a-z0-9_-]{0,62}$, unique
    engine: postgres                   # the only value, and the default
    host: 127.0.0.1                    # required
    port: 5432                         # default 5432
    database: shop                     # required: the PostgreSQL database
    user: shop                         # required
    password_file: /etc/keelson/db-shop   # optional, absolute: read at every run, so a rotation needs no restart
    ssl_mode: require                  # optional: disable|allow|prefer|require|verify-ca|verify-full (PGSSLMODE)
    version: 16                        # optional client major (10-99); empty = the server's, detected
    network: host                      # Docker network of the throwaway containers; default host
    backups:                           # optional: without it the database is only visible
      schedule: "0 3 * * *"            # as a job's: 5-field cron, @daily, "@every 6h"
      timezone: Europe/Berlin          # default UTC
      recipients: ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"]   # required: age public keys
      keep: 14                         # keep the newest N backups (default 14)
      keep_days: 30                    # optional: also delete backups older than N days (0 = off)
      timeout: 30m                     # default 30m, maximum 6h
      alert_after: 1                   # as a job
      paused: false                    # "Backup now" still works
      destinations:                    # one to four places; each is exactly one of local or s3
        - local: {dir: /var/backups/keelson}      # absolute path
        # - s3:
        #     endpoint: https://s3.eu-west-1.amazonaws.com   # https; http only for a loopback host (MinIO on the same machine, tests)
        #     region: eu-west-1
        #     bucket: my-backups
        #     prefix: keelson                    # optional, no leading or trailing slash
        #     access_key_id: AKIA...             # an identifier, not a secret
        #     secret_key_file: /etc/keelson/s3-secret   # absolute: read at every run
```

Passwords and the S3 secret key stay in files and are never sent to the dashboard, which only learns that a password is set. Validation reports one problem per database, with its line.

A backup is a job. Each database with a `backups` section gets a job named `backup-<name>` that is not in the file: it appears in `GET /v1/jobs` with kind `backup`, runs on its schedule, can be run now (`POST /v1/jobs/backup-<name>/run`), keeps its history, and raises `job.failed` / `job.recovered` like any job. A hand-written job cannot take that name, and `PUT`/`DELETE /v1/config/jobs/backup-<name>` fail because the job is not in the document. Removing a database or its `backups` section removes the job, which asks for the same confirmation as removing a job.

Throwaway containers leave nothing behind. The official `postgres` image declares a `VOLUME`, so every container made from it gets an anonymous Docker volume. Throwaway containers (database commands, release steps, container jobs) are therefore removed together with their anonymous volumes (`DELETE /containers/{id}?force=1&v=1`); named volumes and bind mounts are never touched, and an app's own containers are removed without `v`, so their volumes stay. Volumes leaked by an agent older than this fix cannot be told from anyone else's dangling anonymous volumes (Docker labels them only `com.docker.volume.anonymous`), so the agent removes none of them: list them with `docker volume ls -f dangling=true` and, once you have checked that nothing you need is in them, `docker volume prune`.

A run does the following, in this order. The first failure ends it, and nothing is stored unless every check passed:

1. Reads the password file, finds the client image, pulls it if the engine does not have it (anonymous pull of the official `postgres` image).
2. Runs `pg_dump --format=custom --compress=6 --no-owner --no-privileges` in a throwaway container (label `keelson.job`, so a crashed agent's leftovers are removed at the next start; it runs as the agent's own uid and gid so it can write there) on the database's Docker network, writing to a private staging directory `<data-dir>/backup-staging/<id>` (mode 0700).
3. Verifies the dump: a second container runs `pg_restore --list` (it must exit 0 and list at least one object), then `pg_restore -f /dev/null`, which reads all the data: a dump cut short still lists its first objects and passes the first check only.
4. Encrypts the dump with age to every recipient, deletes the plaintext, stores `<db>/<db>-<YYYYMMDDTHHMMSSZ>.dump.age` (UTC) in the destination, then verifies the upload: for a local directory the stored file is hashed again and compared, for S3 a `HEAD` must report the size that was sent. A backup never replaces an existing object: a local file is linked into place (it fails if the name is taken) and an S3 object is sent with `If-None-Match: *` (AWS S3 refuses with `412`; a store that ignores the header keeps last-writer-wins). When the key is taken (the clock was set back, or a file was copied in) the run keeps the old object, tries the key of the next second (up to 10 keys) and says so in its output; if all are taken it fails.
5. Applies retention to this database's backups: it keeps the newest `keep`, deletes those older than `keep_days` (if set), and never deletes the newest backup or the one this run has just stored (its date comes from the clock, which may have been set back). A retention failure is written to the run output and does not fail the backup.
6. Removes the staging directory, whatever happened, and ends the output with a one-line summary (objects in the dump, plain and encrypted sizes, durations).

The destination is the source of truth for which backups exist. The list (size from the listing, date from the file name) comes from the local directory or the bucket, not from a table of the agent. A file in the destination that does not follow the naming scheme is ignored, never listed, restored or deleted.

Client version: `pg_dump` must be at least as new as the server: a newer one reads an older server, not the reverse. With `version` set the image is `postgres:<version>-alpine`. Without it the agent asks the server (`show server_version_num`, from `postgres:17-alpine`) and uses `postgres:<major>-alpine`; the answer is remembered in memory for 10 minutes.

Encryption: create a key pair with `age-keygen` on your own machine, put the public key (`age1...`) in `recipients` and keep the secret key (`AGE-SECRET-KEY-1...`) somewhere that is not this server. The agent can write backups it cannot read, and a restore asks for the secret key each time. If you lose the secret key, the backups are unreadable. List several recipients to let several keys read them. Only age X25519 keys are accepted.

Restore (`POST /v1/databases/{name}/restore`, signed) takes `{backup, identity, target?, overwrite?, confirm?}` and answers `202 {run_id}`; follow it with `GET /v1/databases/{name}/restores`:

- By default into a new database, `<database>_restore_<YYYYMMDD>`: the agent runs `CREATE DATABASE` through the `postgres` maintenance database (the role needs `CREATEDB` and may connect to it), then `pg_restore --exit-on-error --no-owner --no-privileges`. A `target` must match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. If it already exists the run fails before touching anything. If `pg_restore` fails, the new database is left as it is, for you to inspect or drop.
- Over the live database only with `target` equal to the configured database, `overwrite: true` and `confirm` equal to its name; otherwise the request is refused with `400` before any run exists. It first takes a safety backup of the live database (kind `pre-restore`, see [Backup behaviour](#backup-behaviour)): if that fails, nothing is overwritten. Then it runs `pg_restore --clean --if-exists`.
- The run fetches the object, decrypts it (a wrong key says "this key cannot decrypt the backup"), restores from a read-only mount, and ends with a line of row counts of the public schema (50 tables at most) to compare with the source. The restore's own history is kept like a job's under the name `restore-<name>`.
- One restore per database at a time (`409` otherwise); a configuration reload does not cancel it; an agent restart marks it failed.

| Route | Auth | Description |
|---|---|---|
| `GET /v1/databases` | read token | `[{name, engine, host, port, database, user, version, network, has_password, backup: null \| {schedule, timezone, keep, keep_days, paused, destination, recipients, job, next_run, last_run}}]`. No password, no secret key file. |
| `GET /v1/databases/{name}/live` | read token | The server's `{server_version, size_bytes, client_image}`, asked through a throwaway container (60 s timeout, answer kept 60 s). Unreachable: `502 {error}` with a fixed sentence for the kind of failure (server, secret file, destination); the detail (the last line PostgreSQL printed, the path of a secret file) is in the agent's log. Concurrent calls share one probe container. |
| `GET /v1/databases/{name}/backups` | read token | `[{key, name, size_bytes, created_at}]`, newest first, read from the destination (`502 {error}` when it is unreachable; `[]` without a `backups` section). |
| `GET /v1/databases/{name}/restores?limit=` | read token | Recent restore runs, newest first, shaped like job runs. |
| `POST /v1/databases/{name}/restore` | signature | `{backup, identity, target?, overwrite?, confirm?}` -> `202 {run_id}`; `400` (rule broken), `404`, `409` (a restore is running). |
| `POST /v1/databases/{name}/verify-key` | signature | `{identity, backup?}` -> `200 {ok: true, backup, backup_time}` or `200 {ok: false, reason: wrong_key\|not_age\|no_backup\|fetch_failed}`: the key authenticates the first block of the newest scheduled backup (or the one named); `400` for a value that is not an age secret key, `404`. A success is recorded as a proof. The identity is never logged, audited or stored. |
| `POST /v1/databases/{name}/restore-test` | signature | `{identity, backup?}` -> `202 {test_id}`; `409` while a restore, a backup or another test runs on that database. Restores the backup into a scratch database `<db>_rt_<8 hex>` on the same server, counts the rows of every table (200 at most, in byte order of `schema.table`) in the scratch and in the live database, and always drops the scratch (a crash leaves its name in the store, and the next start drops it). **Passed** means: the restore completed without error, the restored database has at least one table, and it holds at least one row unless the live database has none. Differences between the two counts are reported, not judged (the backup is older). A pass is recorded as a proof. |
| `GET /v1/databases/{name}/restore-tests?limit=` | read token | `[{id, backup, backup_time, started_at, finished_at?, status: running\|passed\|failed, error?, tables: [{name, backup_rows, live_rows}]}]`, newest first (20 kept); a table found on one side only has `null` on the other. |
| `POST /v1/notifications/test` | signature | `{channels: [{channel: telegram\|webhook, ok, reason?: timeout\|refused\|rejected\|other}]}` (empty when none is configured): one test event through the live notifier, never an error string that could quote a URL, not stored in the history. A test where every channel answers is recorded as a proof. |
| `GET /v1/proofs` | read token | `[{kind: key\|alert\|restore, subject, at}]`: the latest successful proof per kind and subject, kept in the agent's database across restarts. The dashboard's readiness checklist reads these facts and stores none. |
| `PUT` / `DELETE /v1/config/databases/{name}` | signature | `{database, base_hash, ...}`, like jobs. |

Security notes:

- The password reaches PostgreSQL as `PGPASSWORD` in the **environment** of a throwaway container that lives for seconds (never on a command line, never in a file). It is part of the container's configuration, so it is visible in `docker inspect` to anyone who can use the Docker socket while the container exists (and in the leftover of a crash, until the next start removes it): the same people who are root-equivalent already.
- Write access to the backup destination is write access to the database on restore. age gives confidentiality (only the holders of the secret key can read a backup) but no authenticity: anyone who can write to the directory or the bucket can put a file there that decrypts with a public key (the public keys are in the agent's configuration) and carries any SQL a `pg_restore` runs, and a restore of it trusts it. Give the destination credentials to the agent only (a bucket policy that lets it write and list, and read only for the restores you run), do not share the bucket with other writers, and restore only a backup you know the agent made (its date and size in the run history).
- `password_file` and `secret_key_file` must be readable by the `keelson` user and by nobody else (mode 0600); the agent does not check their permissions, it reads them at every run and fails the run when it cannot.
- The age secret key is held in memory for one restore and nowhere else: it is not logged, not stored, not put in the audit log (which records the database, the backup key, the target and the overwrite flag), not passed to a container. The request that carries it is signed and, with the installer's setup, travels over mutual TLS; the dashboard does not keep it.
- The plaintext dump exists only in the staging directory, mode 0700 inside `<data-dir>`, from the end of `pg_dump` to the end of encryption; a crash leaves it until the next start, which removes it.
- A local destination must be writable by the agent's unit. The installed unit has `ProtectSystem=full` (so `/etc` and `/usr` are read-only) and `ProtectHome=read-only`: a path under `/etc` or `/home` cannot be written, while `/var` can. Use something like `/var/backups/keelson` (create it and give it to the `keelson` user), or allow another path with a drop-in that survives upgrades: `sudo systemctl edit keelson-agent` and add `[Service]` / `ReadWritePaths=/srv/backups`. Keep a copy off the server as well: backups kept only on the server they protect do not survive its loss (use S3 for that).
- S3 requests are signed with Signature Version 4 and always path-style (`endpoint/bucket/key`), which AWS S3, MinIO, Cloudflare R2, Scaleway and Backblaze B2 should accept (only MinIO has been tried). Redirects are not followed (a `3xx` is an error that asks you to check the endpoint and region), and the store has one minute to answer once a request is sent. An object is sent in one request, so a backup larger than 5 GiB (after compression and encryption) cannot be uploaded: multipart upload is not implemented.

Limits: only PostgreSQL; a server that needs a client certificate or a Unix socket is not reachable (the connection is TCP, `host` is a name or an address); a database that needs a role other than the one configured to restore is not handled (`--no-owner --no-privileges` make objects belong to the connecting role).

## Managed PostgreSQL

For an app that only needs a database, the agent can create it: one PostgreSQL container per server, and a database and a role per app. You install nothing and invent no password. It is opt-in per app and never touches a database you declared by hand.

```
POST   /v1/postgres/databases                 {"app":"shop","name":"shop","env_key":"DATABASE_URL","backup":{"keep":7}}
GET    /v1/postgres                           the instance: running, version, size, volume, port, memory, its databases
POST   /v1/postgres/databases/{name}/password rotate the role's password
DELETE /v1/postgres/databases/{name}          {"confirm":"<name>"}: drops the database and its role
```

Mutations are signed like every other write (and behind the mTLS gate); `GET` takes the read token. `app` must be in the apps file, `name` defaults to the app's name, `env_key` to `DATABASE_URL`. The call is idempotent: repeating it after a crash completes what was left.

A `POST` does the following, in order: it ensures the instance (below), creates the role and the database, stores the URL as the app's variable `env_key` (the variables store, write-only like any other: see [Environment variables and secrets](./environment.md)), writes a `database:` block into the app in the apps file (`database: {name, env_key, password_file, backups}`), from which the agent derives a database entry, so the backup, restore and listing code above works on it unchanged: a `backup-<name>` job, `restore-<name>` runs, the Databases pages, and answers `redeploy_required: true`, because an app reads its variables when it starts.

The instance is the container `keelson-postgres`, `postgres:16-alpine` by default, with its data in the named volume `keelson-postgres-data` (never removed by the agent), `restart: unless-stopped`, a memory cap (512 MiB by default) with server settings sized from it, a health check, and a label that is how the agent recognises it. It is created by the first request, and a reconciler (every 30 s, and at start) brings it back if it, or Docker, went down. A server that never asks for a database never gets one. The settings, all optional and applied only when the container is created:

```yaml
managed_postgres:
  version: 16        # major, 14 to 17
  port: 5442         # the loopback port, for apps on the host network
  memory: 512m
```

How an app reaches it: the URL is built for the app's network mode, and the instance is never published on a public interface:

| App | Host in the URL | How |
|---|---|---|
| default or user-defined network | `keelson-postgres:5432` | the instance lives on the Docker network `keelson`; the app's containers join it too |
| `network: host` | `127.0.0.1:5442` | the instance is published on 127.0.0.1 only |
| `network: none`, `container:...` | refused | such an app can reach neither |

Secrets: the superuser's password and each role's are generated by the agent (32 random bytes), kept in files of mode 0600 in directories of mode 0700 under `<data-dir>/postgres`, and never put in SQLite, the audit log, events, errors or a command line. A role's password reaches PostgreSQL as a SCRAM-SHA-256 verifier, not as the password. The URL's password is percent-encoded. If the data exist but the superuser's password file does not, the agent refuses with an explicit message instead of inventing a password the data would not match.

Backups are always on and default to daily at 03:00, the newest 7 kept, into `<data-dir>/backups/<name>`, encrypted with age. When the request names no recipient the agent generates a key pair, keeps only the public half, and returns the private key once (`backup_key`) and never stores or logs it. Keep it: without it the backups are unreadable. `new_backup_key: true` replaces the recipients with a fresh pair for a client that lost the answer. A destination of your choice (a directory, or S3: see above) goes in `backup` of the request. The default destination is on the same disk as the data, so it protects against a mistake but not against losing the server. Point it at S3 for that.

Deleting needs `{"confirm":"<name>"}` (the name, typed) and drops the database and its role (and any database the role made, such as a restore into a new one), removes the entry and the variable, and keeps the backup files. It is refused while a backup or a restore of that database runs. Restoring into a new database, listing backups and `Live()` are the existing database features.

Limits: one instance per server; no automatic major upgrade (dump with the backup job and restore into a new instance); the instance has a memory cap, not a CPU one; the database a role owns is the only one it can use (it cannot connect to another app's); a preview instance never gets a database (point its variables at a scratch one); an app that must keep its build free of the URL is fine, as the URL's variable can never be marked *build*.


## Backup behaviour

- One backup of a database runs at a time. A cron backup, a manual one and the pre-migration `backup` step share a lock: the second waits (up to 10 minutes) for the first instead of taking a second dump at the same time. A restore of the same database is still refused while a backup runs.
- A deployment's backup is kept apart. The `backup` release step takes a `pre-deploy` backup (the key ends `-pre-deploy.dump.age`), counted by `keep_pre_deploy` (5 by default) and never by `keep`, so a week of deployments cannot push the nightly backups out. It reuses a backup of the same database taken in the last two minutes by anyone else. The safety backup before an overwrite restore is a third kind, `pre-restore`, kept the same way.
- Room is checked before the dump. With a previous backup to compare with, the staging directory and each local destination must have 2.5 times its size free: the dump would otherwise fill the disk that Postgres and Docker share. With no previous backup nothing is known and nothing is refused.
- `destinations` lists at most 4 places; every one must hold the backup, and when one refuses, the copies already stored are removed: a backup that is not where it was promised to be is not a backup of record. Retention runs on each. Listing and restore read the first one that answers.
- S3 uploads are tried again (three attempts, one second, then four) after a 5xx, a 429 or a dropped connection, never after a refusal (4xx) or a taken key.
- A restore over the live database takes a safety backup first, and without it nothing is overwritten. Row counts after any restore cover every non-system schema (`audit.` tables included), the public ones by name and the others as `schema.table`.
- A backup does not capture roles and their passwords, and the grants on tables (the dump is taken with `--no-owner --no-privileges`, and a restore recreates the tables without them, so a read-only role of your own, for a build say, has to be granted again after restoring over a live database). A live restore also holds exclusive locks for the whole of its transaction: the site stalls on those tables meanwhile.
