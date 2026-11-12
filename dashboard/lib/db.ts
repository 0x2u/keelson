import "server-only";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * migrations[i] upgrades the schema from version i to i+1. Released entries
 * are never edited: a change is a new entry.
 */
const migrations: string[] = [
  `
  CREATE TABLE servers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    url               TEXT NOT NULL,
    token_enc         TEXT NOT NULL,
    deploy_secret_enc TEXT,
    ca_cert           TEXT,
    client_cert       TEXT,
    client_key_enc    TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  `,
  `
  -- Second factors, sessions and the audit trail. One operator: the factor row is a singleton.
  CREATE TABLE auth_factor (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    totp_secret_enc   TEXT,
    totp_confirmed_at INTEGER,
    totp_last_step    INTEGER NOT NULL DEFAULT -1
  );
  INSERT INTO auth_factor (id) VALUES (1);

  CREATE TABLE recovery_codes (
    hash       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    used_at    INTEGER
  );

  CREATE TABLE passkeys (
    id           TEXT PRIMARY KEY,
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL,
    transports   TEXT,
    name         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    method       TEXT NOT NULL,
    revoked_at   INTEGER
  );

  CREATE TABLE login_failures (
    key TEXT NOT NULL,
    at  INTEGER NOT NULL
  );
  CREATE INDEX login_failures_key ON login_failures (key, at);

  CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     INTEGER NOT NULL,
    event  TEXT NOT NULL,
    detail TEXT,
    ip     TEXT
  );
  CREATE INDEX audit_log_at ON audit_log (at DESC);
  `,
  `
  -- Outside services the dashboard reads from. The token is encrypted like the server secrets.
  CREATE TABLE integrations (
    provider   TEXT PRIMARY KEY,
    token_enc  TEXT NOT NULL,
    account    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- The repository an app is built from, so its page can show commits and CI runs next to its deployments.
  CREATE TABLE app_repos (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    app       TEXT NOT NULL,
    repo      TEXT NOT NULL,
    branch    TEXT NOT NULL,
    PRIMARY KEY (server_id, app)
  );
  `,
  `
  -- The last time this dashboard got an answer from the agent, so an unreachable server says since when.
  ALTER TABLE servers ADD COLUMN last_seen_at INTEGER;
  `,
  `
  -- Automatic deploys: the workflow whose success on the linked branch deploys the app (NULL = off), and what
  -- each GitHub delivery did to each app. A redelivery reuses its delivery id, so the row is the memory that
  -- keeps one delivery from deploying twice.
  ALTER TABLE app_repos ADD COLUMN auto_deploy_workflow TEXT;

  CREATE TABLE webhook_deliveries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id   TEXT NOT NULL,
    at            INTEGER NOT NULL,
    repo          TEXT NOT NULL,
    branch        TEXT NOT NULL,
    sha           TEXT NOT NULL,
    server_id     TEXT NOT NULL,
    app           TEXT NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('deployed', 'skipped', 'failed')),
    detail        TEXT NOT NULL,
    deployment_id TEXT,
    UNIQUE (delivery_id, server_id, app)
  );
  CREATE INDEX webhook_deliveries_app ON webhook_deliveries (server_id, app, at DESC);
  `,
  `
  -- A delivery is claimed (pending) before any work, so two concurrent deliveries cannot both deploy; a deploy
  -- request that timed out has the outcome unknown (it may have started). run_key is the signed body's workflow
  -- run id and attempt: a second delivery id for the same run is the same event. SQLite cannot change a CHECK in
  -- place, so the table is rebuilt; databases that already have it keep their rows.
  CREATE TABLE webhook_deliveries_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id   TEXT NOT NULL,
    at            INTEGER NOT NULL,
    repo          TEXT NOT NULL,
    branch        TEXT NOT NULL,
    sha           TEXT NOT NULL,
    server_id     TEXT NOT NULL,
    app           TEXT NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('pending', 'deployed', 'skipped', 'failed', 'unknown')),
    detail        TEXT NOT NULL,
    deployment_id TEXT,
    run_key       TEXT,
    UNIQUE (delivery_id, server_id, app)
  );
  INSERT INTO webhook_deliveries_new (id, delivery_id, at, repo, branch, sha, server_id, app, outcome, detail, deployment_id)
    SELECT id, delivery_id, at, repo, branch, sha, server_id, app, outcome, detail, deployment_id FROM webhook_deliveries;
  DROP TABLE webhook_deliveries;
  ALTER TABLE webhook_deliveries_new RENAME TO webhook_deliveries;
  CREATE INDEX webhook_deliveries_app ON webhook_deliveries (server_id, app, at DESC);
  CREATE INDEX webhook_deliveries_run ON webhook_deliveries (server_id, app, run_key);
  `,
  `
  -- Previews: the workflow whose success on a pull request builds the image of its head commit (NULL = off).
  -- Linking the app to another repository or branch resets it, like auto_deploy_workflow.
  ALTER TABLE app_repos ADD COLUMN previews_workflow TEXT;
  `,
  `
  -- GitHub App builds: the app's agent builds and deploys from a push to the linked branch (build_on_push) and from a
  -- pull request of the same repository (build_previews). Off by default; linking the app to another repository or
  -- branch resets both, like the workflow columns.
  ALTER TABLE app_repos ADD COLUMN build_on_push INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE app_repos ADD COLUMN build_previews INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- API tokens for machines (the REST API under /api/v1 and the MCP server on top of it). Only the SHA-256 of the
  -- token is kept: the token itself is shown once, at creation. scope: read (every GET) or deploy (also deploy,
  -- rollback and job runs). servers: a JSON list of server ids the token is limited to, NULL = all.
  -- An expiry is required. The name is unique among the tokens that are not revoked.
  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('read', 'deploy')),
    servers      TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at   INTEGER
  );
  CREATE UNIQUE INDEX api_tokens_active_name ON api_tokens (name COLLATE NOCASE) WHERE revoked_at IS NULL;

  -- Who did it, when it was not the operator signing in: "token:<name>" for a call made with an API token.
  ALTER TABLE audit_log ADD COLUMN actor TEXT;
  `,
  `
  -- "Connect GitHub" (the App manifest flow): one single-use state per attempt, kept only as its SHA-256, bound to the
  -- session that started it and valid for ten minutes. GitHub brings the state back with the code; consuming it
  -- deletes the row, so a replay finds nothing.
  CREATE TABLE github_app_states (
    hash       TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  -- The address that domains of this server must point at, when it cannot be read from the agent's URL (a host name that
  -- resolves to several addresses, an agent reached over a private network or a tunnel). NULL = derive it.
  ALTER TABLE servers ADD COLUMN public_ip TEXT;
  `,
  `
  -- The domain this server's new projects are given a host name under (<project>.<apps_domain>), when the operator sets one.
  -- NULL = no default: the wizard asks for a domain, or uses a local port.
  ALTER TABLE servers ADD COLUMN apps_domain TEXT;
  `,
  `
  -- An app that is built on another server: its builds run on build_server, as the builder app build_app (an app of that
  -- agent with build.only), and the image is sent to the app's own server. NULL = the app builds where it runs.
  ALTER TABLE app_repos ADD COLUMN build_server TEXT;
  ALTER TABLE app_repos ADD COLUMN build_app TEXT;
  `,
  `
  -- A machine that connects out to the dashboard (a build machine behind NAT) instead of being reached at a URL:
  -- transport 'relay', url '', no certificates. It proves who it is with a credential of which only the SHA-256 is kept.
  ALTER TABLE servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'direct' CHECK (transport IN ('direct', 'relay'));
  ALTER TABLE servers ADD COLUMN relay_credential_hash TEXT;
  CREATE UNIQUE INDEX servers_relay_credential ON servers (relay_credential_hash) WHERE relay_credential_hash IS NOT NULL;

  -- Single-use enrolment codes for such machines, kept as their SHA-256 like API tokens. used_at is set by the
  -- enrolment that consumed the code.
  CREATE TABLE relay_codes (
    code_hash  TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  `,
  `
  -- Step-up: a session that has just proved the password and a second factor may change configuration, secrets and servers
  -- until this time (milliseconds); NULL = not elevated.
  ALTER TABLE sessions ADD COLUMN elevated_until INTEGER;

  -- A value encrypted with the master key, for the health check to decrypt when the database holds no other secret yet:
  -- the check then still proves the key is the one the data was written with. Written once, on the first healthy check.
  CREATE TABLE key_check (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    value_enc TEXT NOT NULL
  );
  `,
  `
  -- A machine that connects out is a build machine (serves 0) or a full server that runs apps (serves 1: it was installed with
  -- the one-command install). Every relay row that exists today is a build machine.
  ALTER TABLE servers ADD COLUMN serves INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Builds are a request to any server (POST /v1/builds), not an app on it: where an app is built is the server alone
  -- (build_server, NULL = the app's own). The name of the builder app it used to name is dropped; a row that chose another
  -- server keeps that server.
  ALTER TABLE app_repos DROP COLUMN build_app;
  `,
  `
  -- When the operator last downloaded a copy of this database (Settings > Backup): one row, written by the download. The
  -- readiness checklist reads it; the copy itself never contains the master key.
  CREATE TABLE dashboard_backup (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    last_backup_at INTEGER NOT NULL
  );
  `,
  `
  -- The default notification settings (Settings > Notifications): one row holding the non-secret part the operator applies to
  -- servers on demand, as JSON (events, thresholds, cooldown, the Telegram chat and the paths of the secret files, the number of
  -- webhook slots). Not desired state: each server's own file on its agent stays the truth, and whether a server follows the
  -- default is computed by comparing the two. No secret is ever stored here.
  CREATE TABLE notifications_default (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    body       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- First-run setup in the browser. The operator's password hash when KEELSON_ADMIN_PASSWORD_HASH is not set (the variable
  -- always wins); no row = setup mode. The setup token is kept only as its SHA-256 and is deleted when it is used. The
  -- recovery step is the screen that follows setup, open for the session setup began until the operator confirms they saved
  -- the recovery file (downloaded_at: the file was fetched; done_at: the step was closed, and the key is not offered again).
  CREATE TABLE admin_password (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    hash       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE setup_token (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE setup_recovery (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    session_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    downloaded_at INTEGER,
    done_at       INTEGER
  );
  `,
  `
  -- Logins that passed the password and owe a second factor. The signed cookie names a row; the row counts the attempts, so a
  -- cookie that is sent again and again cannot try more codes than the row allows (the cookie alone cannot say how many were tried).
  CREATE TABLE pending_logins (
    id         TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- What a code may do: 'enrol' makes a server of the machine that spends it; 'upgrade' only lets the server it was made for download the
  -- agent to replace its own (server_id), and enrols nothing. Codes made before this column were all enrolment codes.
  ALTER TABLE relay_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'enrol';
  ALTER TABLE relay_codes ADD COLUMN server_id TEXT;
  `,
];

/** The schema version this code creates and expects (the number of migrations). */
export const SCHEMA_VERSION = migrations.length;

/** How many copies taken before a schema upgrade are kept next to the database. */
const UPGRADE_COPIES_KEPT = 3;
const UPGRADE_COPY_MARK = ".before-upgrade-from-v";

/**
 * A consistent copy of a database that is about to change shape, `<file>.before-upgrade-from-v<N>`: a schema upgrade is
 * forward-only and an older dashboard refuses a newer schema, so this is what going back to the previous version restores.
 * Best effort: a full disk or an unwritable directory is a warning, not a reason to stop an upgrade that would otherwise
 * work. Only the newest few copies are kept.
 */
function copyBeforeUpgrade(db: DatabaseSync, file: string, version: number): void {
  if (file === "" || file === ":memory:" || file.startsWith("file:")) return;
  const copy = `${file}${UPGRADE_COPY_MARK}${version}`;
  try {
    rmSync(copy, { force: true });
    // VACUUM INTO needs a target that does not exist or is empty: created private first, so the copy never has wider rights.
    writeFileSync(copy, "", { mode: 0o600 });
    chmodSync(copy, 0o600);
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } catch (err) {
    try {
      rmSync(copy, { force: true });
    } catch {
      // not a file of ours (a directory stands where the copy goes): left as it is
    }
    console.warn(`could not copy the database before upgrading it (${(err as Error).message}): going on without`);
    return;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}${UPGRADE_COPY_MARK}`;
    const copies = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs, from: Number(name.slice(prefix.length)) || 0 }))
      .sort((a, b) => b.at - a.at || b.from - a.from);
    for (const old of copies.slice(UPGRADE_COPIES_KEPT)) rmSync(path.join(dir, old.name), { force: true });
  } catch (err) {
    console.warn(`could not remove old copies of the database: ${(err as Error).message}`);
  }
}

function migrate(db: DatabaseSync, file: string): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  if (version > migrations.length) {
    throw new Error(
      `database schema version ${version} is newer than this dashboard supports: restore the copy taken before the update (Settings > Backup) or run the newer version`,
    );
  }
  // A database that has data and is about to change shape is copied first.
  if (version > 0 && version < migrations.length) copyBeforeUpgrade(db, file, version);
  for (; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`); // PRAGMA takes no bound parameters
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migrate schema to version ${version + 1}: ${(err as Error).message}`);
    }
  }
}

/** Opens a database file and brings it to the current schema. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file);
  return db;
}

// One connection per process, kept across dev hot reloads.
const holder = globalThis as unknown as { keelsonDb?: DatabaseSync };

/** The directory that holds dashboard.db, created private on first use. */
export function dataDir(): string {
  // The data directory is chosen at run time: tell Turbopack not to trace the project for it.
  const dir = path.resolve(/* turbopackIgnore: true */ process.env.KEELSON_DASHBOARD_DATA_DIR ?? "./data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function db(): DatabaseSync {
  if (!holder.keelsonDb) holder.keelsonDb = openDatabase(path.join(dataDir(), "dashboard.db"));
  return holder.keelsonDb;
}
