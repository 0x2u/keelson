import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { throttleBucket } from "@/lib/client-ip";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { base32Encode, generateSecret, verifyTotp } from "@/lib/auth/totp";

/** Idle sessions end after 2 hours; no session lives more than 12 hours. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
/** last_seen is written at most this often, so reads do not become writes. */
const TOUCH_EVERY_MS = 60 * 1000;

const RECOVERY_CODES = 10;

// ---- Audit trail ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  at: number;
  event: string;
  detail: string | null;
  ip: string | null;
  /** "token:<name>" for a call made with an API token; null for the operator and for the system. */
  actor: string | null;
}

/** Records a security-relevant event. Never put a secret in `detail`. */
export function audit(event: string, detail?: string, ip?: string, actor?: string): void {
  db()
    .prepare("INSERT INTO audit_log (at, event, detail, ip, actor) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), event, detail ?? null, ip ?? null, actor ?? null);
}

/** The newest entries; with `events`, only those event codes (the Security page's "sensitive" filter). */
export function recentAudit(limit = 50, events?: readonly string[]): AuditEntry[] {
  if (events !== undefined && events.length === 0) return [];
  const where = events === undefined ? "" : `WHERE event IN (${events.map(() => "?").join(", ")})`;
  return db()
    .prepare(`SELECT id, at, event, detail, ip, actor FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...(events ?? []), limit) as unknown as AuditEntry[];
}

/**
 * Whether this address has never signed in before while other sign-ins are on record: the first sign-in ever is not "new",
 * and neither is a deployment that cannot tell clients apart ("local"). Call it before recording the sign-in.
 */
export function isNewLoginAddress(ip: string): boolean {
  if (ip === "local" || ip === "unknown") return false;
  const seen = db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login' AND ip = ?").get(ip) as { n: number };
  if (seen.n > 0) return false;
  const any = db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login'").get() as { n: number };
  return any.n > 0;
}

// ---- Login throttle -----------------------------------------------------------------------

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

// Every function below counts under `throttleBucket(key)`: an IPv6 client is its /64 (see lib/client-ip.ts), so rotating
// addresses inside a network does not start a fresh count. The audit log keeps the address itself.

/** Failures survive a restart: an attacker cannot reset the counter by crashing the process. */
export function isLoginBlocked(key: string, now: number = Date.now()): boolean {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?")
    .get(throttleBucket(key), now - FAILURE_WINDOW_MS) as { n: number };
  return row.n >= MAX_FAILURES;
}

/**
 * How long a blocked key must wait, in milliseconds (0 when it is not blocked): until the failure that makes
 * the count reach the limit leaves the window.
 */
export function loginBlockedForMs(key: string, now: number = Date.now()): number {
  const rows = db()
    .prepare("SELECT at FROM login_failures WHERE key = ? AND at > ? ORDER BY at DESC LIMIT ?")
    .all(throttleBucket(key), now - FAILURE_WINDOW_MS, MAX_FAILURES) as { at: number }[];
  if (rows.length < MAX_FAILURES) return 0;
  return rows[MAX_FAILURES - 1].at + FAILURE_WINDOW_MS - now;
}

export function recordLoginFailure(key: string, now: number = Date.now()): void {
  db().prepare("INSERT INTO login_failures (key, at) VALUES (?, ?)").run(throttleBucket(key), now);
  db().prepare("DELETE FROM login_failures WHERE at <= ?").run(now - FAILURE_WINDOW_MS);
}

export function clearLoginFailures(key: string): void {
  db().prepare("DELETE FROM login_failures WHERE key = ?").run(throttleBucket(key));
}

// ---- Second factor: attempts per pending login, and across all addresses ------------------------

/** A password that was right owes a second factor: this many codes may be tried on it, then the password is asked for again. */
export const PENDING_LOGIN_MAX_ATTEMPTS = 5;

/** Opens a pending login (the cookie of a password that was right names it) and forgets the ones that have run out. */
export function createPendingLogin(ttlMs: number, now: number = Date.now()): string {
  const id = randomBytes(18).toString("base64url");
  db().prepare("DELETE FROM pending_logins WHERE expires_at <= ?").run(now);
  db().prepare("INSERT INTO pending_logins (id, expires_at) VALUES (?, ?)").run(id, now + ttlMs);
  return id;
}

/** Whether the pending login is still there: not expired, not spent, not out of attempts. Reads only (the verify page). */
export function pendingLoginOpen(id: string, now: number = Date.now()): boolean {
  const row = db().prepare("SELECT attempts FROM pending_logins WHERE id = ? AND expires_at > ?").get(id, now) as { attempts: number } | undefined;
  return row !== undefined && row.attempts < PENDING_LOGIN_MAX_ATTEMPTS;
}

/**
 * Uses up one attempt of the pending login BEFORE the code is looked at, in one statement: requests that arrive together
 * with the same cookie each take a distinct attempt, so the cap holds however they are sent. Returns how many attempts the
 * login has used now (the one just taken included), or null when none was left (or it is expired, spent or unknown).
 */
export function takePendingAttempt(id: string, now: number = Date.now()): number | null {
  const row = db()
    .prepare("UPDATE pending_logins SET attempts = attempts + 1 WHERE id = ? AND expires_at > ? AND attempts < ? RETURNING attempts")
    .get(id, now, PENDING_LOGIN_MAX_ATTEMPTS) as { attempts: number } | undefined;
  return row === undefined ? null : row.attempts;
}

/** The code was right, or was wrong on the last attempt: the pending login is over and cannot be used again. */
export function endPendingLogin(id: string): void {
  db().prepare("DELETE FROM pending_logins WHERE id = ?").run(id);
}

/** After this many wrong second factors, from anywhere, in the window, the next try has to wait. */
export const SECOND_FACTOR_CEILING = 30;
/** How long it waits after the latest wrong one: this slows a guessing run to a couple of tries a minute, and ends with it. */
export const SECOND_FACTOR_SLOWDOWN_MS = 30 * 1000;
const SECOND_FACTOR_KEY = "second-factor:all";

/**
 * How long, in milliseconds, a second factor must wait before it is looked at (0 when it may be tried now): once the
 * addresses together have failed `SECOND_FACTOR_CEILING` times in the window, tries are spaced
 * `SECOND_FACTOR_SLOWDOWN_MS` after the latest failure. It slows; it does not lock out: the operator's turn comes as soon as the
 * guessing pauses, and a right code is never a failure. Rotating addresses does not get around it: it counts all of them.
 */
export function secondFactorWaitMs(now: number = Date.now()): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM login_failures WHERE key = ? AND at > ?")
    .get(SECOND_FACTOR_KEY, now - FAILURE_WINDOW_MS) as { n: number; last: number | null };
  if (row.n < SECOND_FACTOR_CEILING || row.last === null) return 0;
  return Math.max(0, row.last + SECOND_FACTOR_SLOWDOWN_MS - now);
}

/** A wrong authenticator or recovery code, counted across every address. */
export function recordSecondFactorFailure(now: number = Date.now()): void {
  db().prepare("INSERT INTO login_failures (key, at) VALUES (?, ?)").run(SECOND_FACTOR_KEY, now);
}

// ---- TOTP ----------------------------------------------------------------------------------

interface FactorRow {
  totp_secret_enc: string | null;
  totp_confirmed_at: number | null;
  totp_last_step: number;
}

function factor(): FactorRow {
  return db().prepare("SELECT totp_secret_enc, totp_confirmed_at, totp_last_step FROM auth_factor WHERE id = 1").get() as unknown as FactorRow;
}

export function totpEnabled(): boolean {
  return factor().totp_confirmed_at !== null;
}

/** Thrown by beginTotpSetup while an authenticator is enabled: replacing its secret is a removal followed by a new setup. */
export class TotpAlreadyEnabledError extends Error {
  constructor() {
    super("an authenticator app is already enabled: remove it first");
  }
}

/**
 * Starts (or restarts) enrolment: the secret is stored but does not protect anything until confirmed. Refused while an
 * authenticator is confirmed: restarting would wipe the secret that protects the sign-in (and its confirmation) without the
 * checks that removing it has. Replacing it goes through the removal flow.
 */
export function beginTotpSetup(): string {
  if (factor().totp_confirmed_at !== null) throw new TotpAlreadyEnabledError();
  const secret = generateSecret();
  db().prepare("UPDATE auth_factor SET totp_secret_enc = ?, totp_confirmed_at = NULL, totp_last_step = -1 WHERE id = 1").run(encrypt(secret));
  return secret;
}

/** The secret of an enrolment in progress, to show the QR code again after a reload. */
export function pendingTotpSecret(): string | null {
  const f = factor();
  return f.totp_secret_enc && f.totp_confirmed_at === null ? decrypt(f.totp_secret_enc) : null;
}

/** Confirms enrolment with a first valid code. Returns the recovery codes on the first activation. */
export function confirmTotp(code: string, now: number = Date.now()): { recoveryCodes: string[] } | null {
  const f = factor();
  if (!f.totp_secret_enc || f.totp_confirmed_at !== null) return null;
  const step = verifyTotp(decrypt(f.totp_secret_enc), code, now);
  if (step === null) return null;
  db().prepare("UPDATE auth_factor SET totp_confirmed_at = ?, totp_last_step = ? WHERE id = 1").run(now, step);
  return { recoveryCodes: recoveryCodesLeft() === 0 ? regenerateRecoveryCodes() : [] };
}

/** A login code. A code is accepted once: its step is recorded. */
export function verifyTotpLogin(code: string, now: number = Date.now()): boolean {
  const f = factor();
  if (!f.totp_secret_enc || f.totp_confirmed_at === null) return false;
  const step = verifyTotp(decrypt(f.totp_secret_enc), code, now, f.totp_last_step);
  if (step === null) return false;
  // The comparison in WHERE makes the claim atomic: two concurrent logins cannot both use a step.
  const claimed = db().prepare("UPDATE auth_factor SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?").run(step, step);
  return Number(claimed.changes) === 1;
}

export function disableTotp(): void {
  db().prepare("UPDATE auth_factor SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = -1 WHERE id = 1").run();
}

// ---- Recovery codes -------------------------------------------------------------------------

function hashRecovery(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
}

/** Replaces every recovery code. The plain codes are returned once and never stored. */
export function regenerateRecoveryCodes(now: number = Date.now()): string[] {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const conn = db();
  conn.exec("BEGIN");
  try {
    conn.exec("DELETE FROM recovery_codes");
    const insert = conn.prepare("INSERT INTO recovery_codes (hash, created_at) VALUES (?, ?)");
    for (const c of codes) insert.run(hashRecovery(c), now);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return codes;
}

/** Spends a recovery code. True once per code. */
export function spendRecoveryCode(code: string, now: number = Date.now()): boolean {
  const spent = db().prepare("UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(now, hashRecovery(code));
  return Number(spent.changes) === 1;
}

export function recoveryCodesLeft(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL").get() as { n: number }).n;
}

// ---- Passkeys -------------------------------------------------------------------------------

export interface PasskeyRecord {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeyRow {
  id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

function toPasskey(r: PasskeyRow): PasskeyRecord {
  return {
    id: r.id,
    publicKey: new Uint8Array(r.public_key),
    counter: r.counter,
    transports: r.transports ? r.transports.split(",") : [],
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export function listPasskeys(): PasskeyRecord[] {
  return (db().prepare("SELECT * FROM passkeys ORDER BY created_at").all() as unknown as PasskeyRow[]).map(toPasskey);
}

export function getPasskey(id: string): PasskeyRecord | null {
  const row = db().prepare("SELECT * FROM passkeys WHERE id = ?").get(id) as unknown as PasskeyRow | undefined;
  return row ? toPasskey(row) : null;
}

export function addPasskey(p: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; name: string }, now: number = Date.now()): void {
  db()
    .prepare("INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(p.id, p.publicKey, p.counter, p.transports.join(","), p.name, now);
}

export function touchPasskey(id: string, counter: number, now: number = Date.now()): void {
  db().prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, now, id);
}

export function deletePasskey(id: string): boolean {
  return Number(db().prepare("DELETE FROM passkeys WHERE id = ?").run(id).changes) > 0;
}

// ---- Second factor policy ------------------------------------------------------------------

/** Whether a password alone is enough to sign in. */
export function secondFactorEnrolled(): boolean {
  return totpEnabled() || listPasskeys().length > 0;
}

// ---- Sessions -------------------------------------------------------------------------------

export type LoginMethod = "password" | "password+totp" | "password+recovery" | "passkey";

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  method: LoginMethod;
  /** Until when a fresh password and second factor lets this session change configuration, secrets and servers; null = not elevated. */
  elevatedUntil: number | null;
}

interface SessionRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  method: LoginMethod;
  elevated_until: number | null;
}

function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    ip: r.ip,
    userAgent: r.user_agent,
    method: r.method,
    elevatedUntil: r.elevated_until,
  };
}

export function createSessionRecord(
  meta: { ip?: string; userAgent?: string; method: LoginMethod },
  now: number = Date.now(),
): SessionRecord {
  const id = randomUUID();
  const expiresAt = now + SESSION_MAX_MS;
  db()
    .prepare("INSERT INTO sessions (id, created_at, last_seen_at, expires_at, ip, user_agent, method) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, now, now, expiresAt, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, meta.method);
  // Old rows are cleaned here, as sessions are created rarely.
  db().prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(now - 7 * 86_400_000, now - 7 * 86_400_000);
  return { id, createdAt: now, lastSeenAt: now, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, method: meta.method, elevatedUntil: null };
}

/** The session if it is still valid: not revoked, not past its lifetime, not idle for too long. */
export function liveSession(id: string, now: number = Date.now()): SessionRecord | null {
  const row = db().prepare("SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, method, elevated_until FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;
  if (row.expires_at <= now || row.last_seen_at + SESSION_IDLE_MS <= now) return null;
  if (now - row.last_seen_at >= TOUCH_EVERY_MS) {
    db().prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, id);
    row.last_seen_at = now;
  }
  return toSession(row);
}

export function listLiveSessions(now: number = Date.now()): SessionRecord[] {
  return (
    db()
      .prepare(
        "SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, method, elevated_until FROM sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC",
      )
      .all(now, now - SESSION_IDLE_MS) as unknown as SessionRow[]
  ).map(toSession);
}

export function revokeSession(id: string, now: number = Date.now()): boolean {
  return Number(db().prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes) > 0;
}

/** How long a fresh password + second factor lets a session change configuration, secrets and servers. */
export const STEP_UP_MS = 10 * 60 * 1000;

/** Marks a live session as elevated until `now + STEP_UP_MS`. False when the session is gone. */
export function elevateSession(id: string, now: number = Date.now()): boolean {
  return Number(db().prepare("UPDATE sessions SET elevated_until = ? WHERE id = ? AND revoked_at IS NULL").run(now + STEP_UP_MS, id).changes) > 0;
}

/** Signs out everywhere, optionally keeping the session the operator is using. */
export function revokeOtherSessions(keepId: string | null, now: number = Date.now()): number {
  return Number(db().prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id IS NOT ?").run(now, keepId).changes);
}
