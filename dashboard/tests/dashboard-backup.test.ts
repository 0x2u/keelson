import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-dashboard-backup-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let sessionId = "";
vi.mock("@/lib/session", async () => {
  const { liveSession } = await import("@/lib/auth/store");
  return {
    currentSession: async () => (sessionId ? liveSession(sessionId) : null),
    clientInfo: async () => ({ ip: "198.51.100.9" }),
  };
});

const { db } = await import("@/lib/db");
const store = await import("@/lib/auth/store");
const servers = await import("@/lib/servers");
const { lastBackupAt } = await import("@/lib/dashboard-backup");
const { POST } = await import("@/app/api/dashboard-backup/route");

const MASTER_KEY = process.env.KEELSON_DASHBOARD_KEY ?? "";
const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);

/** The directories the copy is made in: none may be left behind. */
const leftovers = () => readdirSync(dir).filter((n) => n.startsWith(".backup-"));

beforeEach(() => {
  for (const table of ["sessions", "audit_log", "login_failures", "dashboard_backup", "github_app_states", "admin_password", "setup_token", "setup_recovery"]) db().exec(`DELETE FROM ${table}`);
  sessionId = store.createSessionRecord({ ip: "198.51.100.9", userAgent: "test", method: "password" }).id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const unlock = () => expect(store.elevateSession(sessionId, Date.now())).toBe(true);

async function download(): Promise<Buffer> {
  const res = await POST();
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe("downloading a copy of the dashboard", () => {
  it("needs a session", async () => {
    sessionId = "";
    expect((await POST()).status).toBe(401);
    expect(lastBackupAt()).toBeNull();
  });

  it("needs the session to be unlocked: nothing is made, recorded or audited as a download", async () => {
    const res = await POST();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Unlock changes first/);
    expect(leftovers()).toEqual([]);
    expect(lastBackupAt()).toBeNull();
    expect(store.recentAudit(10).map((e) => e.event)).toEqual(["step_up_required"]);
  });

  it("sends a SQLite file with the servers in it and no key material", async () => {
    servers.createServer({ name: "prod", url: "https://203.0.113.7:8443", token: TOKEN, deploySecret: SECRET });
    unlock();
    const res = await POST();
    expect(res.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="keelson-dashboard-\d{8}-\d{6}\.db"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const file = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(file.length);
    expect(file.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\u0000");

    // The master key (as the environment holds it, and as bytes) and the plain credentials are nowhere in it.
    expect(MASTER_KEY).toHaveLength(64);
    for (const needle of [MASTER_KEY, Buffer.from(MASTER_KEY, "hex").toString("latin1"), TOKEN, SECRET]) expect(file.toString("latin1")).not.toContain(needle);

    // It is a database a dashboard can open, with the servers (their credentials encrypted).
    const copy = openCopy(file);
    try {
      expect(copy.prepare("SELECT name, url FROM servers").all()).toEqual([{ name: "prod", url: "https://203.0.113.7:8443" }]);
      expect((copy.prepare("SELECT token_enc FROM servers").get() as { token_enc: string }).token_enc).toMatch(/^v1:/);
      expect((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    } finally {
      copy.close();
      rmSync(copyPath, { force: true });
    }
  });

  it("leaves out the signed-in sessions, the sign-in throttle, the GitHub App states and the first-run setup, even their bytes", async () => {
    store.recordLoginFailure("203.0.113.99");
    db().prepare("INSERT INTO pending_logins (id, expires_at) VALUES ('pending-login-marker', ?)").run(Date.now() + 60_000);
    db().prepare("INSERT INTO github_app_states (hash, session_id, created_at, expires_at) VALUES ('deadbeefstate', ?, 1, 2)").run(sessionId);
    db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, 'scrypt:stored-password-hash-marker', 1) ON CONFLICT (id) DO NOTHING").run();
    db().prepare("INSERT INTO setup_token (id, token_hash, created_at, expires_at) VALUES (1, 'setup-token-hash-marker', 1, 2) ON CONFLICT (id) DO NOTHING").run();
    db().prepare("INSERT INTO setup_recovery (id, session_id, created_at) VALUES (1, 'setup-recovery-marker', 1) ON CONFLICT (id) DO NOTHING").run();
    unlock();
    const file = await download();
    const text = file.toString("latin1");
    expect(text).not.toContain(sessionId);
    expect(text).not.toContain("deadbeefstate");
    expect(text).not.toContain("pending-login-marker");
    expect(text).not.toContain("203.0.113.99");
    for (const marker of ["stored-password-hash-marker", "setup-token-hash-marker", "setup-recovery-marker"]) expect(text).not.toContain(marker);
    const copy = openCopy(file);
    try {
      for (const table of ["sessions", "login_failures", "pending_logins", "github_app_states", "admin_password", "setup_token", "setup_recovery"]) expect(copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      // The rest of the sign-in data is kept: it is what a restored dashboard needs.
      expect(copy.prepare("SELECT COUNT(*) AS n FROM auth_factor").get()).toEqual({ n: 1 });
    } finally {
      copy.close();
      rmSync(copyPath, { force: true });
    }
    // The live database still has its session.
    expect(store.liveSession(sessionId)).not.toBeNull();
  });

  it("records the time and audits dashboard_backup without anything but the size", async () => {
    unlock();
    const before = Date.now();
    const file = await download();
    const at = lastBackupAt();
    expect(at).not.toBeNull();
    expect(at ?? 0).toBeGreaterThanOrEqual(before);
    const entries = store.recentAudit(10).filter((e) => e.event === "dashboard_backup");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ detail: `${file.length} bytes`, ip: "198.51.100.9" });
    // A second download moves the time, it does not add a row.
    await download();
    expect(db().prepare("SELECT COUNT(*) AS n FROM dashboard_backup").get()).toEqual({ n: 1 });
  });

  it("removes the copy once it is sent, and when the client gives up", async () => {
    unlock();
    await download();
    await vi.waitFor(() => expect(leftovers()).toEqual([]));
    const res = await POST();
    await res.body?.cancel();
    await vi.waitFor(() => expect(leftovers()).toEqual([]));
  });
});

let copyPath = "";
/** Opens what was downloaded as a database. */
function openCopy(file: Buffer): DatabaseSync {
  copyPath = path.join(dir, `downloaded-${Math.random().toString(36).slice(2)}.db`);
  writeFileSync(copyPath, file);
  return new DatabaseSync(copyPath, { readOnly: true });
}
