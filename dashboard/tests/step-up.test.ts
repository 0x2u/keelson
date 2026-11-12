import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, DatabaseConfig, JobConfig } from "@/lib/agent-types";
import * as policy from "@/lib/step-up-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-step-up-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let sessionId = "";
vi.mock("@/lib/session", async () => {
  const { liveSession } = await import("@/lib/auth/store");
  return {
    currentSession: async () => (sessionId ? liveSession(sessionId) : null),
    clientInfo: async () => ({ ip: "198.51.100.9" }),
    requireSession: async () => {},
  };
});

const { db } = await import("@/lib/db");
const store = await import("@/lib/auth/store");
const { stepUpError, unlock } = await import("@/lib/step-up");
const { totpCode } = await import("@/lib/auth/totp");

const PASSWORD = "operator-password-1";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const sensitive = policy.variables();

beforeEach(() => {
  for (const table of ["sessions", "audit_log", "login_failures", "recovery_codes"]) db().exec(`DELETE FROM ${table}`);
  db().exec("UPDATE auth_factor SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = -1 WHERE id = 1");
  sessionId = store.createSessionRecord({ ip: "198.51.100.9", userAgent: "test", method: "password" }).id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function enrolTotp(): string {
  const secret = store.beginTotpSetup();
  expect(store.confirmTotp(totpCode(secret))).not.toBeNull();
  return secret;
}

describe("the policy: what needs the session to be unlocked", () => {
  const app: AppConfig = { name: "web", image: "ghcr.io/o/web", port: 3000, domains: ["a.example.com"], drain: "5s", health_timeout: "60s" };

  it("lets day-to-day edits through: timings, the soak, labels, restart and log settings", () => {
    const edited: AppConfig = { ...app, drain: "10s", health_timeout: "2m", soak: "1m", stop_timeout: "30s", stable_after: "20s", restart: "always", keep_images: 5, log: { max_size: "10m" }, project: "shop", environment: "production" };
    expect(policy.appChange(app, edited)).toEqual({ required: false });
  });

  it("asks for what changes where traffic goes or which source runs: variables, domains, port, health and verification, previews, the repository", () => {
    for (const edit of [
      { env: { DATABASE_URL: "https://evil.example.com" } },
      { domains: ["a.example.com", "evil.example.com"] },
      { domains: [] },
      { port: { container: 8080 } },
      { health_path: "/evil" },
      { verify: [{ path: "/" }] },
      { previews: { domain: "evil.example.com" } },
      { source: { repo: "evil/web" } },
    ] as unknown as Partial<AppConfig>[]) {
      expect(policy.appChange(app, { ...app, ...edit }).required, JSON.stringify(edit)).toBe(true);
    }
  });

  it("does not count an empty list or map as a change from none", () => {
    const bare: AppConfig = { name: "x", image: "i" };
    expect(policy.appChange(bare, { ...bare, domains: [], env: {}, volumes: [], publish: [], verify: [] })).toEqual({ required: false });
  });

  it("asks for a record at Cloudflare unless it is new and for a host name the server declares", () => {
    expect(policy.dnsRecord("a.example.com", { declared: true, replacing: false })).toEqual({ required: false });
    expect(policy.dnsRecord("a.example.com", { declared: true, replacing: true }).required).toBe(true);
    expect(policy.dnsRecord("a.example.com", { declared: false, replacing: false }).required).toBe(true);
  });

  it("asks for what makes the server run something else or reach somewhere else", () => {
    for (const edit of [
      { image: "ghcr.io/evil/web" },
      { command: ["sh", "-c", "id"] },
      { volumes: ["/:/host"] },
      { publish: ["22:22"] },
      { network: "host" },
      { env_file: "/etc/shadow" },
      { release: { steps: [{ name: "x", host: ["sh"] }] } },
      { build: { dockerfile: "Dockerfile.evil" } },
    ] as Partial<AppConfig>[]) {
      expect(policy.appChange(app, { ...app, ...edit }).required, JSON.stringify(edit)).toBe(true);
    }
    expect(policy.appChange(undefined, app).required).toBe(true);
    expect(policy.appRemoval("web").required).toBe(true);
  });

  it("asks for a project to be renamed, whatever it holds", () => {
    const verdict = policy.projectRename("shop", "store");
    expect(verdict.required).toBe(true);
    expect(verdict.required && verdict.reason).toContain("shop");
  });

  it("does not care how the keys were ordered", () => {
    const a: AppConfig = { name: "x", image: "i", build: { dockerfile: "D", args: { A: "1", B: "2" } } };
    const b: AppConfig = { build: { args: { B: "2", A: "1" }, dockerfile: "D" }, image: "i", name: "x" };
    expect(policy.appChange(a, b)).toEqual({ required: false });
  });

  it("asks when a job's action changes, not when its schedule does", () => {
    const job: JobConfig = { name: "j", schedule: "0 4 * * *", http: { url: "https://x.example.com/cron", method: "POST", bearer: { app: "web", env: "CRON_SECRET" } }, timeout: "1m" };
    expect(policy.jobChange(job, { ...job, schedule: "0 5 * * *", timeout: "5m", alert_after: 3, paused: true })).toEqual({ required: false });
    expect(policy.jobChange(job, { ...job, http: { ...job.http!, url: "https://evil.example.com/" } }).required).toBe(true);
    expect(policy.jobChange(job, { ...job, http: { ...job.http!, bearer: { app: "web", env: "OTHER" } } }).required).toBe(true);
    expect(policy.jobChange(job, { name: "j", schedule: "0 4 * * *", host: ["sh", "-c", "id"] }).required).toBe(true);
    expect(policy.jobChange(undefined, job).required).toBe(true);
  });

  it("asks when a database's connection or backup destination changes, not its schedule or retention", () => {
    const db1: DatabaseConfig = { name: "shop", host: "127.0.0.1", database: "shop", user: "shop", password_file: "/etc/keelson/db", backups: { schedule: "30 3 * * *", keep: 10, recipients: ["age1abc"], destinations: [{ local: { dir: "/var/backups" } }] } };
    expect(policy.databaseChange(db1, { ...db1, backups: { ...db1.backups!, schedule: "0 2 * * *", keep: 30 } })).toEqual({ required: false });
    expect(policy.databaseChange(db1, { ...db1, backups: { ...db1.backups!, recipients: ["age1evil"] } }).required).toBe(true);
    expect(policy.databaseChange(db1, { ...db1, backups: { ...db1.backups!, destinations: [{ s3: { bucket: "x" } }] } as never }).required).toBe(true);
    expect(policy.databaseChange(db1, { ...db1, host: "10.0.0.9" }).required).toBe(true);
  });

  it("asks when alerts would go somewhere else, not when the events or thresholds change", () => {
    const n = { name: "vps", events: ["app.down"], telegram: { bot_token_file: "/t", chat_id: "1" }, webhooks: [{ url: "<hidden>" }] };
    expect(policy.notificationsChange(n, { ...n, events: ["app.down", "disk.high"], disk_alert_percent: 90, alert_cooldown: "10m" })).toEqual({ required: false });
    expect(policy.notificationsChange(n, { ...n, telegram: { bot_token_file: "/t", chat_id: "2" } }).required).toBe(true);
    expect(policy.notificationsChange(n, { ...n, webhooks: [{ url: "<hidden>" }, { url: "https://evil.example.com" }] }).required).toBe(true);
  });

  it("always asks for the raw editor, a restored version, variables and servers", () => {
    expect(policy.rawDocument("editor").required).toBe(true);
    expect(policy.rawDocument("restore").required).toBe(true);
    expect(policy.variables().required).toBe(true);
    for (const what of ["add", "update", "delete", "install", "uninstall"] as const) expect(policy.servers(what).required).toBe(true);
  });
});

describe("asking the session to be unlocked", () => {
  it("lets a change that needs nothing through without looking at the session", async () => {
    sessionId = "";
    expect(await stepUpError({ required: false }, "x")).toBeNull();
  });

  it("refuses a sensitive change to a session that has not unlocked, says why, and audits the demand", async () => {
    const message = await stepUpError(sensitive, "stored variables");
    expect(message).toContain("Variables are the secrets an app runs with.");
    expect(message).toContain("Unlock changes");
    expect(store.recentAudit(5).map((e) => [e.event, e.detail])).toEqual([["step_up_required", "stored variables"]]);
  });

  it("lets it through for ten minutes after the password and the code, and not a moment later", async () => {
    const secret = enrolTotp();
    expect(await unlock(form({ password: PASSWORD, code: totpCode(secret, Date.now() + 30_000) }))).toMatchObject({ until: expect.any(Number) });
    expect(await stepUpError(sensitive, "x")).toBeNull();
    const session = store.liveSession(sessionId)!;
    expect(session.elevatedUntil! - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(session.elevatedUntil! - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    db().prepare("UPDATE sessions SET elevated_until = ? WHERE id = ?").run(Date.now() - 1, sessionId);
    expect(await stepUpError(sensitive, "x")).toContain("Unlock changes");
  });
});

describe("unlocking", () => {
  it("needs the password: a wrong one unlocks nothing, is counted and audited", async () => {
    expect(await unlock(form({ password: "wrong" }))).toEqual({ error: "Wrong password." });
    expect(store.liveSession(sessionId)!.elevatedUntil).toBeNull();
    expect(store.recentAudit(5).map((e) => e.event)).toEqual(["security_confirm_failed"]);
    for (let i = 0; i < 4; i++) await unlock(form({ password: "wrong" }));
    expect(await unlock(form({ password: PASSWORD }))).toEqual({ error: "Too many failed attempts. Try again in a few minutes." });
  });

  it("with an authenticator enrolled, needs a code as well: a missing or wrong one unlocks nothing", async () => {
    const secret = enrolTotp();
    expect(await unlock(form({ password: PASSWORD }))).toEqual({ error: "That code is not valid." });
    expect(await unlock(form({ password: PASSWORD, code: "000000" }))).toEqual({ error: "That code is not valid." });
    expect(store.liveSession(sessionId)!.elevatedUntil).toBeNull();
    expect(store.recentAudit(5).map((e) => e.event)).toContain("step_up_failed");
    const ok = await unlock(form({ password: PASSWORD, code: totpCode(secret, Date.now() + 30_000) }));
    expect(ok.until).toBeGreaterThan(Date.now());
    expect(store.recentAudit(3).map((e) => e.event)).toContain("step_up_granted");
  });

  it("accepts a recovery code once", async () => {
    enrolTotp();
    const [code] = store.regenerateRecoveryCodes();
    expect((await unlock(form({ password: PASSWORD, code }))).until).toBeGreaterThan(Date.now());
    db().prepare("UPDATE sessions SET elevated_until = NULL WHERE id = ?").run(sessionId);
    expect(await unlock(form({ password: PASSWORD, code }))).toEqual({ error: "That code is not valid." });
  });

  it("without an authenticator the password is enough, and a session that has ended unlocks nothing", async () => {
    expect((await unlock(form({ password: PASSWORD }))).until).toBeGreaterThan(Date.now());
    sessionId = "";
    expect(await unlock(form({ password: PASSWORD }))).toEqual({ error: "Your session has ended. Sign in again." });
  });

  it("is per session: unlocking one leaves another locked", async () => {
    await unlock(form({ password: PASSWORD }));
    const other = store.createSessionRecord({ ip: "203.0.113.7", userAgent: "other", method: "password" });
    expect(store.liveSession(other.id)!.elevatedUntil).toBeNull();
  });
});

describe("adding a way to sign in", () => {
  it("is refused to a session that has not unlocked, and an authenticator that is enabled cannot be restarted", async () => {
    const { startTotpSetupAction } = await import("@/app/auth-actions");
    const refused = await startTotpSetupAction();
    expect("error" in refused && refused.error).toContain("adds a way to sign in");
    expect(store.pendingTotpSecret()).toBeNull();

    const secret = enrolTotp();
    await unlock(form({ password: PASSWORD, code: totpCode(secret, Date.now() + 30_000) }));
    const again = await startTotpSetupAction();
    expect("error" in again && again.error).toContain("already enabled");
    expect(store.totpEnabled()).toBe(true); // the secret that protects the sign-in is untouched
  });
});
