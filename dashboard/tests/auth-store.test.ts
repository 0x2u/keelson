import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "@/lib/auth/totp";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-auth-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// Imported after the data dir is set: the database opens lazily on first use.
const store = await import("@/lib/auth/store");
const { db } = await import("@/lib/db");

beforeEach(() => {
  for (const table of ["sessions", "login_failures", "audit_log", "recovery_codes", "passkeys"]) db().exec(`DELETE FROM ${table}`);
  store.disableTotp();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;

describe("TOTP enrolment", () => {
  it("protects nothing until the first code is confirmed, then hands out recovery codes once", () => {
    const secret = store.beginTotpSetup();
    expect(store.totpEnabled()).toBe(false);
    expect(store.secondFactorEnrolled()).toBe(false);
    expect(store.verifyTotpLogin(totpCode(secret, NOW), NOW)).toBe(false);

    expect(store.confirmTotp("000000", NOW)).toBeNull();
    const done = store.confirmTotp(totpCode(secret, NOW), NOW);
    expect(done?.recoveryCodes).toHaveLength(10);
    expect(store.totpEnabled()).toBe(true);
    expect(store.secondFactorEnrolled()).toBe(true);
    expect(store.recoveryCodesLeft()).toBe(10);
  });

  it("stores the secret encrypted", () => {
    const secret = store.beginTotpSetup();
    const raw = db().prepare("SELECT totp_secret_enc FROM auth_factor WHERE id = 1").get() as { totp_secret_enc: string };
    expect(raw.totp_secret_enc).not.toContain(secret);
    expect(store.pendingTotpSecret()).toBe(secret);
  });

  it("accepts a login code once, even for a concurrent second attempt", () => {
    const secret = store.beginTotpSetup();
    store.confirmTotp(totpCode(secret, NOW), NOW);

    const later = NOW + 60_000;
    const code = totpCode(secret, later);
    expect(store.verifyTotpLogin(code, later)).toBe(true);
    expect(store.verifyTotpLogin(code, later)).toBe(false);
    expect(store.verifyTotpLogin(totpCode(secret, later + 30_000), later + 30_000)).toBe(true);
  });

  it("does not accept the code that confirmed enrolment as a login code", () => {
    const secret = store.beginTotpSetup();
    const code = totpCode(secret, NOW);
    store.confirmTotp(code, NOW);
    expect(store.verifyTotpLogin(code, NOW)).toBe(false);
  });

  it("restarting enrolment discards the old secret", () => {
    const first = store.beginTotpSetup();
    const second = store.beginTotpSetup();
    expect(second).not.toBe(first);
    expect(store.confirmTotp(totpCode(first, NOW), NOW)).toBeNull();
    expect(store.confirmTotp(totpCode(second, NOW), NOW)).not.toBeNull();
  });
});

describe("recovery codes", () => {
  it("works once each, in any case or spacing, and regenerating invalidates the old ones", () => {
    const codes = store.regenerateRecoveryCodes(NOW);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    expect(store.spendRecoveryCode(codes[0].toUpperCase(), NOW)).toBe(true);
    expect(store.spendRecoveryCode(codes[0], NOW)).toBe(false);
    expect(store.spendRecoveryCode(codes[1].replace("-", " "), NOW)).toBe(true);
    expect(store.spendRecoveryCode("zzzzz-zzzzz", NOW)).toBe(false);
    expect(store.recoveryCodesLeft()).toBe(8);

    const fresh = store.regenerateRecoveryCodes(NOW);
    expect(store.spendRecoveryCode(codes[2], NOW)).toBe(false);
    expect(store.spendRecoveryCode(fresh[0], NOW)).toBe(true);
  });

  it("never stores a code in clear", () => {
    const [code] = store.regenerateRecoveryCodes(NOW);
    const rows = JSON.stringify(db().prepare("SELECT * FROM recovery_codes").all());
    expect(rows).not.toContain(code.replace("-", ""));
  });
});

describe("sessions", () => {
  it("is live until revoked, expired or idle", () => {
    const s = store.createSessionRecord({ ip: "1.2.3.4", userAgent: "ua", method: "password" }, NOW);
    expect(store.liveSession(s.id, NOW + 1000)).not.toBeNull();
    expect(store.liveSession("nope", NOW)).toBeNull();

    expect(store.liveSession(s.id, NOW + store.SESSION_IDLE_MS + 1)).toBeNull();

    const kept = store.createSessionRecord({ method: "passkey" }, NOW);
    // Activity every hour keeps it alive past the idle limit, but never past the absolute one.
    for (let t = NOW + 3_600_000; t < NOW + store.SESSION_MAX_MS; t += 3_600_000) expect(store.liveSession(kept.id, t)).not.toBeNull();
    expect(store.liveSession(kept.id, NOW + store.SESSION_MAX_MS + 1)).toBeNull();

    const gone = store.createSessionRecord({ method: "password" }, NOW);
    expect(store.revokeSession(gone.id, NOW + 5)).toBe(true);
    expect(store.revokeSession(gone.id, NOW + 6)).toBe(false);
    expect(store.liveSession(gone.id, NOW + 10)).toBeNull();
  });

  it("lists live sessions and signs out all the others", () => {
    const a = store.createSessionRecord({ method: "password" }, NOW);
    const b = store.createSessionRecord({ method: "passkey" }, NOW + 10);
    const c = store.createSessionRecord({ method: "password+totp" }, NOW + 20);
    store.revokeSession(c.id, NOW + 30);

    expect(store.listLiveSessions(NOW + 40).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(store.revokeOtherSessions(a.id, NOW + 50)).toBe(1);
    expect(store.listLiveSessions(NOW + 60).map((s) => s.id)).toEqual([a.id]);
  });
});

describe("login throttle", () => {
  it("blocks a key after five failures inside the window, per key, and survives in the database", () => {
    for (let i = 0; i < 4; i++) store.recordLoginFailure("1.1.1.1", NOW + i);
    expect(store.isLoginBlocked("1.1.1.1", NOW + 10)).toBe(false);
    store.recordLoginFailure("1.1.1.1", NOW + 5);
    expect(store.isLoginBlocked("1.1.1.1", NOW + 10)).toBe(true);
    expect(store.isLoginBlocked("2.2.2.2", NOW + 10)).toBe(false);
    expect(store.isLoginBlocked("1.1.1.1", NOW + 16 * 60_000)).toBe(false);
    store.clearLoginFailures("1.1.1.1");
    expect(store.isLoginBlocked("1.1.1.1", NOW + 10)).toBe(false);
  });
});

describe("passkeys and the audit trail", () => {
  it("stores, finds, updates and deletes a passkey", () => {
    store.addPasskey({ id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal", "hybrid"], name: "Laptop" }, NOW);
    expect(store.secondFactorEnrolled()).toBe(true);
    const p = store.getPasskey("cred1")!;
    expect(Array.from(p.publicKey)).toEqual([1, 2, 3]);
    expect(p.transports).toEqual(["internal", "hybrid"]);
    store.touchPasskey("cred1", 7, NOW + 1);
    expect(store.getPasskey("cred1")).toMatchObject({ counter: 7, lastUsedAt: NOW + 1 });
    expect(store.deletePasskey("cred1")).toBe(true);
    expect(store.getPasskey("cred1")).toBeNull();
    expect(store.secondFactorEnrolled()).toBe(false);
  });

  it("returns the newest audit entries first", () => {
    store.audit("login", "password", "1.1.1.1");
    store.audit("logout");
    const [latest, previous] = store.recentAudit(10);
    expect(latest).toMatchObject({ event: "logout", detail: null, ip: null });
    expect(previous).toMatchObject({ event: "login", detail: "password", ip: "1.1.1.1" });
  });
});
