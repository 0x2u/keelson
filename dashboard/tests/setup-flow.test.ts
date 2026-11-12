import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

// The first-run setup end to end, without a browser: the token, the password, the session it opens, the recovery step and the
// file. Each test is a fresh process on a fresh data directory, in setup mode unless it says otherwise.

const ENV_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ENV_HASH = hashPassword("operator-password-1");
const PASSWORD = "a long enough password";
const SAVED = { key: process.env.KEELSON_DASHBOARD_KEY, hash: process.env.KEELSON_ADMIN_PASSWORD_HASH, dir: process.env.KEELSON_DASHBOARD_DATA_DIR };
const dirs: string[] = [];
const holder = globalThis as unknown as { keelsonDb?: { close(): void } };

let ip = "198.51.100.7";
let current: string | null = null;
let sessionsOpened: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/session", async () => {
  const store = await import("@/lib/auth/store");
  return {
    clientInfo: async () => ({ ip }),
    createSession: async (method: "password") => {
      const record = store.createSessionRecord({ ip, userAgent: "test", method });
      store.audit("login", method, ip);
      current = record.id;
      sessionsOpened.push(method);
      return record.id;
    },
    currentSession: async () => (current ? store.liveSession(current) : null),
  };
});

async function load(opts: { key?: "env"; hash?: "env" } = {}) {
  holder.keelsonDb?.close();
  delete holder.keelsonDb;
  vi.resetModules();
  const data = mkdtempSync(path.join(tmpdir(), "keelson-setup-flow-"));
  dirs.push(data);
  process.env.KEELSON_DASHBOARD_DATA_DIR = data;
  if (opts.key === "env") process.env.KEELSON_DASHBOARD_KEY = ENV_KEY;
  else delete process.env.KEELSON_DASHBOARD_KEY;
  if (opts.hash === "env") process.env.KEELSON_ADMIN_PASSWORD_HASH = ENV_HASH;
  else delete process.env.KEELSON_ADMIN_PASSWORD_HASH;
  ip = "198.51.100.7";
  current = null;
  sessionsOpened = [];
  const [actions, setup, store, env, dbm, route, sessionToken] = await Promise.all([
    import("@/app/setup/actions"),
    import("@/lib/auth/setup"),
    import("@/lib/auth/store"),
    import("@/lib/env"),
    import("@/lib/db"),
    import("@/app/setup/recovery/file/route"),
    import("@/lib/session-token"),
  ]);
  return { data, actions, setup, store, env, db: dbm.db, route, sessionToken };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

/** What a redirect()-ing action or page redirected to, or null when it returned. */
async function redirectOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (err) {
    const m = /^REDIRECT (.+)$/.exec((err as Error).message);
    if (!m) throw err;
    return m[1];
  }
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  holder.keelsonDb?.close();
  delete holder.keelsonDb;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const [name, value] of [["KEELSON_DASHBOARD_KEY", SAVED.key], ["KEELSON_ADMIN_PASSWORD_HASH", SAVED.hash], ["KEELSON_DASHBOARD_DATA_DIR", SAVED.dir]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the setup token", () => {
  it("is 24 random bytes, kept only as its SHA-256", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const row = t.db().prepare("SELECT token_hash FROM setup_token").get() as { token_hash: string };
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(t.db().prepare("SELECT * FROM setup_token").all())).not.toContain(token);
  });

  it("is a new one at every start, and the one before is void", async () => {
    const t = await load();
    const first = t.setup.issueSetupToken();
    const second = t.setup.issueSetupToken();
    expect(second).not.toBe(first);
    expect(t.setup.setupTokenValid(first)).toBe(false);
    expect(t.setup.setupTokenValid(second)).toBe(true);
  });

  it("expires after a day", async () => {
    const t = await load();
    const now = 1_700_000_000_000;
    const token = t.setup.issueSetupToken(now);
    expect(t.setup.setupTokenValid(token, now + t.setup.SETUP_TOKEN_TTL_MS - 1)).toBe(true);
    expect(t.setup.setupTokenValid(token, now + t.setup.SETUP_TOKEN_TTL_MS)).toBe(false);
  });

  it("is refused when it is wrong, empty, or of another length, and when none was ever issued", async () => {
    const t = await load();
    expect(t.setup.setupTokenValid("anything")).toBe(false);
    const token = t.setup.issueSetupToken();
    for (const wrong of ["", "x", `${token}x`, token.slice(1), token.toUpperCase()]) expect(t.setup.setupTokenValid(wrong), wrong).toBe(false);
  });
});

describe("announcing at start", () => {
  it("prints the address and the token in setup mode, with the fixed prefix scripts look for", async () => {
    const t = await load();
    const { announceFirstRun } = await import("@/lib/auth/first-run");
    const lines: string[] = [];
    announceFirstRun((l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Keelson setup: open http://localhost:3000/setup in your browser to finish the installation.");
    const token = /^Keelson setup token: ([A-Za-z0-9_-]{32})$/.exec(lines[1])?.[1];
    expect(token).toBeTruthy();
    expect(t.setup.setupTokenValid(token!)).toBe(true);
  });

  it("names KEELSON_PUBLIC_URL when it is set", async () => {
    await load();
    process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com/";
    try {
      const { announceFirstRun } = await import("@/lib/auth/first-run");
      const lines: string[] = [];
      announceFirstRun((l) => lines.push(l));
      expect(lines[0]).toContain("https://keelson.example.com/setup");
    } finally {
      delete process.env.KEELSON_PUBLIC_URL;
    }
  });

  it("makes the master key at that start, and prints nothing once a password exists", async () => {
    const t = await load();
    const { announceFirstRun } = await import("@/lib/auth/first-run");
    announceFirstRun(() => {});
    expect(existsSync(path.join(t.data, "master.key"))).toBe(true);
    t.db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, 1)").run(hashPassword(PASSWORD));
    const lines: string[] = [];
    announceFirstRun((l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  it("prints nothing when the password comes from the environment, and makes no token", async () => {
    const t = await load({ key: "env", hash: "env" });
    const { announceFirstRun } = await import("@/lib/auth/first-run");
    const lines: string[] = [];
    announceFirstRun((l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM setup_token").get()).toEqual({ n: 0 });
  });
});

describe("completing the setup", () => {
  it("stores the password, spends the token, opens the first session and goes to the recovery step", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    expect(t.env.setupRequired()).toBe(true);

    expect(await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })))).toBe("/setup/recovery");

    expect(t.env.setupRequired()).toBe(false);
    const stored = (t.db().prepare("SELECT hash FROM admin_password").get() as { hash: string }).hash;
    expect(stored).toMatch(/^scrypt:/);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("another password", stored)).toBe(false);
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM setup_token").get()).toEqual({ n: 0 });
    expect(t.setup.setupTokenValid(token)).toBe(false);

    // The session is the operator's: its cookie verifies against the stored password.
    expect(sessionsOpened).toEqual(["password"]);
    expect(t.env.adminPasswordHash()).toBe(stored);
    const jwt = await t.sessionToken.signToken("session", { sid: current }, 60);
    expect(await t.sessionToken.isValidSessionToken(jwt)).toBe(true);
    expect(t.setup.recoveryStepOf(current!)).toEqual({ downloaded: false });
  });

  it("audits the setup without a secret anywhere", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    await t.actions.completeSetupAction({}, form({ token: "wrong-token", password: PASSWORD, confirm: PASSWORD }));
    await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })));
    const events = t.store.recentAudit(20);
    expect(events.map((e) => e.event).sort()).toEqual(["login", "setup_completed", "setup_failed"]);
    const everything = JSON.stringify([events, t.db().prepare("SELECT * FROM login_failures").all()]);
    for (const secret of [token, PASSWORD, "wrong-token", (t.db().prepare("SELECT hash FROM admin_password").get() as { hash: string }).hash]) expect(everything).not.toContain(secret);
  });

  it("refuses the wrong token, counts it on its own key, and stores nothing", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    const result = await t.actions.completeSetupAction({}, form({ token: `${token}x`, password: PASSWORD, confirm: PASSWORD }));
    expect(result.errors?.token).toMatch(/not valid/);
    expect(t.env.setupRequired()).toBe(true);
    expect(t.setup.setupTokenValid(token)).toBe(true);
    const keys = t.db().prepare("SELECT key FROM login_failures").all() as { key: string }[];
    expect(keys).toEqual([{ key: "setup:198.51.100.7" }]);
    expect(t.store.isLoginBlocked(ip)).toBe(false);
  });

  it("refuses an expired token", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken(Date.now() - t.setup.SETUP_TOKEN_TTL_MS - 1000);
    const result = await t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD }));
    expect(result.errors?.token).toMatch(/not valid/);
    expect(t.env.setupRequired()).toBe(true);
  });

  it("throttles wrong tokens like the login, even for the right one afterwards, and leaves the login alone", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    for (let i = 0; i < 5; i++) {
      const r = await t.actions.completeSetupAction({}, form({ token: `wrong-${i}`, password: PASSWORD, confirm: PASSWORD }));
      expect(r.errors?.token).toBeTruthy();
    }
    const blocked = await t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD }));
    expect(blocked.error).toMatch(/Too many wrong tokens/);
    expect(t.env.setupRequired()).toBe(true);
    expect(t.store.isLoginBlocked(ip)).toBe(false);
    // Another address is not locked out by it.
    ip = "198.51.100.8";
    expect(await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })))).toBe("/setup/recovery");
  });

  it("clears the throttle on success", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    await t.actions.completeSetupAction({}, form({ token: "nope", password: PASSWORD, confirm: PASSWORD }));
    await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })));
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM login_failures").get()).toEqual({ n: 0 });
  });

  it("lists every problem at once, and spends nothing: a short password, a different confirmation, no token", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    const r = await t.actions.completeSetupAction({}, form({ token: "", password: "short", confirm: "other" }));
    expect(r.errors).toEqual({ token: expect.stringMatching(/Enter the setup token/), password: expect.stringMatching(/at least 12 characters \(5 so far\)/), confirm: expect.stringMatching(/differ/) });
    const short = await t.actions.completeSetupAction({}, form({ token, password: "elevenchars", confirm: "elevenchars" }));
    expect(short.errors).toEqual({ password: expect.stringMatching(/at least 12/) });
    expect(t.setup.setupTokenValid(token)).toBe(true);
    expect(t.env.setupRequired()).toBe(true);
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM login_failures").get()).toEqual({ n: 0 });
    // Exactly twelve characters is enough.
    expect(await redirectOf(t.actions.completeSetupAction({}, form({ token, password: "twelve chars", confirm: "twelve chars" })))).toBe("/setup/recovery");
  });

  it("is a one-time thing: once a password exists the action refuses, even with a valid token", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })));
    const before = (t.db().prepare("SELECT hash FROM admin_password").get() as { hash: string }).hash;

    const fresh = t.setup.issueSetupToken(); // a token that is valid, as after a restart
    const again = await t.actions.completeSetupAction({}, form({ token: fresh, password: "a different password", confirm: "a different password" }));
    expect(again.error).toMatch(/already set up/);
    expect((t.db().prepare("SELECT hash FROM admin_password").get() as { hash: string }).hash).toBe(before);
    expect(t.setup.setupTokenValid(fresh)).toBe(true); // not even consumed
  });

  it("refuses when the password comes from the environment, which wins: nothing is stored", async () => {
    const t = await load({ key: "env", hash: "env" });
    const token = t.setup.issueSetupToken();
    const r = await t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD }));
    expect(r.error).toMatch(/already set up/);
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM admin_password").get()).toEqual({ n: 0 });
    expect(sessionsOpened).toEqual([]);
    expect(t.env.adminPasswordHash()).toBe(ENV_HASH);
  });

  it("refuses the same token twice even when both requests passed the checks: only one transaction wins", async () => {
    const t = await load();
    const token = t.setup.issueSetupToken();
    expect(t.setup.completeSetup(token, hashPassword(PASSWORD))).toBe("done");
    expect(t.setup.completeSetup(token, hashPassword("another password"))).toBe("exists");
    const t2 = await load();
    const spent = t2.setup.issueSetupToken();
    t2.db().prepare("DELETE FROM setup_token").run();
    expect(t2.setup.completeSetup(spent, hashPassword(PASSWORD))).toBe("token");
    expect(t2.db().prepare("SELECT COUNT(*) AS n FROM admin_password").get()).toEqual({ n: 0 });
  });
});

describe("the recovery step and file", () => {
  async function setUp(opts: { key?: "env" } = {}) {
    const t = await load({ key: opts.key });
    const token = t.setup.issueSetupToken();
    await redirectOf(t.actions.completeSetupAction({}, form({ token, password: PASSWORD, confirm: PASSWORD })));
    return { t, session: current! };
  }

  it("needs a session", async () => {
    const { t } = await setUp();
    current = null;
    expect((await t.route.POST()).status).toBe(401);
  });

  it("gives the setup session the master key in keelson-recovery.txt, with the instructions, and records it", async () => {
    const { t } = await setUp();
    const res = await t.route.POST();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="keelson-recovery.txt"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    const key = readFileSync(path.join(t.data, "master.key"), "utf8").trim();
    expect(body).toContain(`KEELSON_DASHBOARD_KEY=${key}`);
    expect(body).toMatch(/Keep it apart from the data volume/);
    expect(body).toMatch(/stored server credentials become unreadable/);
    expect(body).toMatch(/shown once/);
    expect(body).not.toContain(PASSWORD);
    expect(t.setup.recoveryStepOf(current!)).toEqual({ downloaded: true });
    const audited = t.store.recentAudit(20).find((e) => e.event === "recovery_file_downloaded");
    expect(audited).toBeTruthy();
    expect(JSON.stringify(audited)).not.toContain(key);
  });

  it("is not for another session, and not for the setup session once the step is closed", async () => {
    const { t, session } = await setUp();
    const other = t.store.createSessionRecord({ ip, userAgent: "test", method: "password" }).id;
    current = other;
    expect((await t.route.POST()).status).toBe(404);
    expect(await redirectOf(t.actions.finishRecoveryAction({}, form({ saved: "on" })))).toBe("/");

    current = session;
    await t.route.POST();
    expect(await redirectOf(t.actions.finishRecoveryAction({}, form({ saved: "on" })))).toBe("/setup/secure");
    const after = await t.route.POST();
    expect(after.status).toBe(404);
    expect(await after.text()).not.toMatch(/[0-9a-f]{64}/);
  });

  it("does not continue before the file was downloaded, or without the confirmation", async () => {
    const { t, session } = await setUp();
    expect((await t.actions.finishRecoveryAction({}, form({ saved: "on" }))).error).toMatch(/Download the recovery file first/);
    await t.route.POST();
    expect((await t.actions.finishRecoveryAction({}, form({}))).error).toMatch(/Confirm that you saved it/);
    expect(t.setup.recoveryStepOf(session)).toEqual({ downloaded: true });
    expect(await redirectOf(t.actions.finishRecoveryAction({}, form({ saved: "on" })))).toBe("/setup/secure");
    expect(t.setup.recoveryStepOf(session)).toBeNull();
  });

  it("offers no file when the key comes from the environment, and continues on the confirmation alone", async () => {
    const { t, session } = await setUp({ key: "env" });
    const res = await t.route.POST();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(ENV_KEY);
    expect(existsSync(path.join(t.data, "master.key"))).toBe(false);
    expect(t.setup.recoveryStepOf(session)).toEqual({ downloaded: false });
    expect(await redirectOf(t.actions.finishRecoveryAction({}, form({ saved: "on" })))).toBe("/setup/secure");
  });

  it("sends a visitor without a session to the sign-in instead of closing the step", async () => {
    const { t } = await setUp();
    current = null;
    expect(await redirectOf(t.actions.finishRecoveryAction({}, form({ saved: "on" })))).toBe("/login");
  });
});
