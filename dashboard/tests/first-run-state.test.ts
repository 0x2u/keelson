import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/password";

// State resolution: where the master key and the admin password come from. The environment always wins; without it the key is a
// file in the data directory and the password a row in the database. Each case starts a fresh "process": modules reloaded, the
// database connection closed, a new data directory.

const ENV_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const ENV_HASH = hashPassword("operator-password-1");
const SAVED = { key: process.env.KEELSON_DASHBOARD_KEY, hash: process.env.KEELSON_ADMIN_PASSWORD_HASH, dir: process.env.KEELSON_DASHBOARD_DATA_DIR };
const dirs: string[] = [];
const holder = globalThis as unknown as { keelsonDb?: { close(): void } };

function closeDb() {
  holder.keelsonDb?.close();
  delete holder.keelsonDb;
}

/** A new process on `dir` (a new directory when not given), with exactly these variables set. */
async function boot(vars: { key?: string; hash?: string }, dir?: string) {
  closeDb();
  vi.resetModules();
  const data = dir ?? mkdtempSync(path.join(tmpdir(), "keelson-first-run-"));
  if (!dir) dirs.push(data);
  process.env.KEELSON_DASHBOARD_DATA_DIR = data;
  if (vars.key === undefined) delete process.env.KEELSON_DASHBOARD_KEY;
  else process.env.KEELSON_DASHBOARD_KEY = vars.key;
  if (vars.hash === undefined) delete process.env.KEELSON_ADMIN_PASSWORD_HASH;
  else process.env.KEELSON_ADMIN_PASSWORD_HASH = vars.hash;
  return { data, env: await import("@/lib/env"), db: await import("@/lib/db"), crypto: await import("@/lib/crypto") };
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  closeDb();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const [name, value] of [["KEELSON_DASHBOARD_KEY", SAVED.key], ["KEELSON_ADMIN_PASSWORD_HASH", SAVED.hash], ["KEELSON_DASHBOARD_DATA_DIR", SAVED.dir]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the master key", () => {
  it("comes from KEELSON_DASHBOARD_KEY when it is set, and no file is made", async () => {
    const { data, env } = await boot({ key: ENV_KEY, hash: ENV_HASH });
    expect(env.keySource()).toBe("environment");
    env.deriveKey("encryption");
    expect(existsSync(path.join(data, "master.key"))).toBe(false);
    expect(() => env.generatedMasterKeyHex()).toThrow(/KEELSON_DASHBOARD_KEY/);
  });

  it("is generated into a private file at the first start when the variable is absent", async () => {
    const { data, env } = await boot({});
    expect(env.keySource()).toBe("file");
    env.deriveKey("encryption");
    const file = path.join(data, "master.key");
    expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(env.masterKeyFile()).toBe(file);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(file));
  });

  it("is reused across restarts: what one start encrypted, the next one decrypts", async () => {
    const first = await boot({});
    const sealed = first.crypto.encrypt("a server token");
    const key = readFileSync(path.join(first.data, "master.key"), "utf8");

    const second = await boot({}, first.data);
    expect(readFileSync(path.join(second.data, "master.key"), "utf8")).toBe(key);
    expect(second.crypto.decrypt(sealed)).toBe("a server token");
    expect(second.env.generatedMasterKeyHex()).toBe(key.trim());
  });

  it("is made once: nothing is announced on the second start", async () => {
    const first = await boot({});
    first.env.deriveKey("encryption");
    vi.mocked(console.log).mockClear();
    const second = await boot({}, first.data);
    second.env.deriveKey("encryption");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("is a different key in every new data directory", async () => {
    const a = (await boot({})).env.generatedMasterKeyHex();
    const b = (await boot({})).env.generatedMasterKeyHex();
    expect(a).not.toBe(b);
  });

  it("is the variable's value, not the file's, when both exist", async () => {
    const first = await boot({});
    const fromFile = first.crypto.encrypt("x");
    const second = await boot({ key: OTHER_KEY }, first.data);
    expect(second.env.keySource()).toBe("environment");
    expect(() => second.crypto.decrypt(fromFile)).toThrow();
    const sealed = second.crypto.encrypt("y");
    const third = await boot({ key: OTHER_KEY }, first.data);
    expect(third.crypto.decrypt(sealed)).toBe("y");
  });

  it("refuses a malformed variable and a malformed file", async () => {
    const { env } = await boot({ key: "not hex" });
    expect(() => env.deriveKey("encryption")).toThrow(/KEELSON_DASHBOARD_KEY must be 64 hex/);

    const file = await boot({});
    writeFileSync(path.join(file.data, "master.key"), "abc\n");
    expect(() => file.env.deriveKey("encryption")).toThrow(/must hold the master key/);
  });

  it("is never replaced when the database already holds data encrypted with it", async () => {
    const first = await boot({});
    first.crypto.encrypt("x");
    first.db.db().prepare("INSERT INTO key_check (id, value_enc) VALUES (1, ?)").run(first.crypto.encrypt("keelson-key-check"));
    rmSync(path.join(first.data, "master.key"));

    const second = await boot({}, first.data);
    expect(() => second.env.deriveKey("encryption")).toThrow(/master\.key is missing/);
    expect(existsSync(path.join(first.data, "master.key"))).toBe(false);
  });

  it("is also protected by a stored server alone (a database from before the key check existed)", async () => {
    const first = await boot({ key: ENV_KEY, hash: ENV_HASH });
    first.db
      .db()
      .prepare("INSERT INTO servers (id, name, url, token_enc, created_at, updated_at) VALUES ('s1', 'edge', 'https://x', ?, 1, 1)")
      .run(first.crypto.encrypt("token"));
    const second = await boot({}, first.data);
    expect(() => second.env.deriveKey("encryption")).toThrow(/master\.key is missing/);
    expect(existsSync(path.join(first.data, "master.key"))).toBe(false);
  });
});

describe("the admin password", () => {
  it("is in setup mode when neither the variable nor a stored password exists", async () => {
    const { env } = await boot({});
    expect(env.setupRequired()).toBe(true);
    expect(() => env.adminPasswordHash()).toThrow(/no admin password is set/);
    expect(() => env.passwordFingerprint()).toThrow(/no admin password is set/);
  });

  it("is KEELSON_ADMIN_PASSWORD_HASH when set: no setup, and no database read", async () => {
    const { data, env } = await boot({ key: ENV_KEY, hash: ENV_HASH });
    expect(env.setupRequired()).toBe(false);
    expect(env.adminPasswordHash()).toBe(ENV_HASH);
    expect(env.passwordFingerprint()).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(path.join(data, "dashboard.db"))).toBe(false);
  });

  it("is the stored hash when the variable is absent, and survives a restart", async () => {
    const first = await boot({});
    const stored = hashPassword("a password set in the browser");
    first.db.db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, 1)").run(stored);
    expect(first.env.setupRequired()).toBe(false);
    expect(first.env.adminPasswordHash()).toBe(stored);

    const second = await boot({}, first.data);
    expect(second.env.setupRequired()).toBe(false);
    expect(second.env.adminPasswordHash()).toBe(stored);
  });

  it("is the variable, not the stored hash, when both exist", async () => {
    const first = await boot({});
    first.db.db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, 1)").run(hashPassword("stored password here"));
    const second = await boot({ hash: ENV_HASH }, first.data);
    expect(second.env.adminPasswordHash()).toBe(ENV_HASH);
  });

  it("leaves setup mode in the same process the moment a password is stored (only a found password is remembered)", async () => {
    const { db, env } = await boot({});
    expect(env.setupRequired()).toBe(true);
    expect(env.setupRequired()).toBe(true);
    db.db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, 1)").run(hashPassword("a password set in the browser"));
    expect(env.setupRequired()).toBe(false);
  });

  it("signs sessions out when the password changes: the fingerprint follows the hash", async () => {
    const first = await boot({ hash: hashPassword("first password here") });
    const before = first.env.passwordFingerprint();
    const second = await boot({ hash: hashPassword("second password here") }, first.data);
    expect(second.env.passwordFingerprint()).not.toBe(before);
    expect(createHash("sha256").update(second.env.adminPasswordHash()).digest("hex").slice(0, 16)).toBe(second.env.passwordFingerprint());
  });

  it("is created by the migration, on a database that came before it: no password, so setup mode", async () => {
    const { data, db } = await boot({});
    const file = path.join(data, "before-setup.db");
    const old = db.openDatabase(file);
    old.exec("DROP TABLE pending_logins");
    for (const table of ["admin_password", "setup_token", "setup_recovery"]) old.exec(`DROP TABLE ${table}`);
    old.exec("ALTER TABLE relay_codes DROP COLUMN server_id");
    old.exec("ALTER TABLE relay_codes DROP COLUMN kind");
    old.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION - 3}`);
    old.close();

    const upgraded = db.openDatabase(file);
    try {
      const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_password', 'setup_token', 'setup_recovery') ORDER BY name").all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual(["admin_password", "setup_recovery", "setup_token"]);
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM admin_password").get()).toEqual({ n: 0 });
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: db.SCHEMA_VERSION });
    } finally {
      upgraded.close();
    }
  });
});
