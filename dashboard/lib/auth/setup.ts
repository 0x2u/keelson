import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

// First-run setup: the one-time token that guards it, the password it stores, and the recovery step that follows. All state
// is in the database (migration "First-run setup"); nothing here is ever logged except the token, once, at start.

/** A setup token is valid for a day; every start in setup mode issues a new one and voids the one before. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 24;

/** The key under which wrong tokens are counted: the login's throttle store, but never the login's own counter. */
export function setupThrottleKey(ip: string): string {
  return `setup:${ip}`;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Makes the token for this start and keeps only its SHA-256. Returns the token: the one place it is ever seen. */
export function issueSetupToken(now: number = Date.now()): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  db()
    .prepare(
      `INSERT INTO setup_token (id, token_hash, created_at, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    )
    .run(digest(token).toString("hex"), now, now + SETUP_TOKEN_TTL_MS);
  return token;
}

/** Whether this is the current, unexpired token. The digests are compared in constant time, and the comparison runs even when there is no token. */
export function setupTokenValid(token: string, now: number = Date.now()): boolean {
  const row = db().prepare("SELECT token_hash, expires_at FROM setup_token WHERE id = 1").get() as { token_hash: string; expires_at: number } | undefined;
  const stored = Buffer.from(row?.token_hash ?? "", "hex");
  const same = timingSafeEqual(digest(token), stored.length === 32 ? stored : Buffer.alloc(32));
  return row !== undefined && same && now < row.expires_at;
}

export type SetupOutcome = "done" | "token" | "exists";

/**
 * Stores the password hash and consumes the token in one transaction: two requests with the same token cannot both succeed,
 * and nothing is written when a password already exists ("exists") or the token is not the current one ("token").
 */
export function completeSetup(token: string, passwordHash: string, now: number = Date.now()): SetupOutcome {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    if (conn.prepare("SELECT 1 FROM admin_password WHERE id = 1").get()) {
      conn.exec("ROLLBACK");
      return "exists";
    }
    const claimed = conn.prepare("DELETE FROM setup_token WHERE id = 1 AND token_hash = ? AND expires_at > ?").run(digest(token).toString("hex"), now);
    if (Number(claimed.changes) !== 1) {
      conn.exec("ROLLBACK");
      return "token";
    }
    conn.prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, ?)").run(passwordHash, now);
    conn.exec("COMMIT");
    return "done";
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

// ---- The recovery step -----------------------------------------------------------------------------------------------

export interface RecoveryStep {
  /** The recovery file was fetched at least once. */
  downloaded: boolean;
}

/** Opens the step for the session setup began: the screen that offers the recovery file, until the operator closes it. */
export function openRecoveryStep(sessionId: string, now: number = Date.now()): void {
  db()
    .prepare(
      `INSERT INTO setup_recovery (id, session_id, created_at, downloaded_at, done_at) VALUES (1, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at, downloaded_at = NULL, done_at = NULL`,
    )
    .run(sessionId, now);
}

/** The open step of this session, or null: it is another session's, it was closed, or setup never ran here. */
export function recoveryStepOf(sessionId: string): RecoveryStep | null {
  const row = db().prepare("SELECT downloaded_at FROM setup_recovery WHERE id = 1 AND session_id = ? AND done_at IS NULL").get(sessionId) as { downloaded_at: number | null } | undefined;
  return row ? { downloaded: row.downloaded_at !== null } : null;
}

export function markRecoveryDownloaded(sessionId: string, now: number = Date.now()): void {
  db().prepare("UPDATE setup_recovery SET downloaded_at = ? WHERE id = 1 AND session_id = ? AND done_at IS NULL").run(now, sessionId);
}

/** Closes the step: the key is not offered again. Returns false when there was no open step for this session. */
export function closeRecoveryStep(sessionId: string, now: number = Date.now()): boolean {
  const closed = db().prepare("UPDATE setup_recovery SET done_at = ? WHERE id = 1 AND session_id = ? AND done_at IS NULL").run(now, sessionId);
  return Number(closed.changes) === 1;
}
