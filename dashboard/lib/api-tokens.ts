import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { DAY_MS, generateToken, hashToken, sameHash, tokenPrefix, tokenStatus, type ApiToken, type NewTokenValues, type TokenStatus } from "@/lib/api-tokens-core";

/** last_used_at is written at most this often per token, so reads do not become writes. */
const TOUCH_EVERY_MS = 60 * 1000;

interface Row {
  id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scope: "read" | "deploy";
  servers: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
}

const COLUMNS = "id, name, token_hash, prefix, scope, servers, created_at, expires_at, last_used_at, last_used_ip, revoked_at";

function toToken(r: Row): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: r.scope,
    servers: r.servers === null ? null : (JSON.parse(r.servers) as string[]),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    revokedAt: r.revoked_at,
  };
}

export class DuplicateTokenNameError extends Error {
  constructor() {
    super("an active token with this name already exists");
  }
}

/** Creates a token. The secret is returned here and nowhere else: only its hash is stored. */
export function createApiToken(values: NewTokenValues, now: number = Date.now()): { token: string; record: ApiToken } {
  const token = generateToken();
  const id = randomUUID();
  try {
    db()
      .prepare(`INSERT INTO api_tokens (id, name, token_hash, prefix, scope, servers, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, values.name, hashToken(token), tokenPrefix(token), values.scope, values.servers === null ? null : JSON.stringify(values.servers), now, now + values.days * DAY_MS);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) throw new DuplicateTokenNameError();
    throw err;
  }
  return { token, record: getApiToken(id)! };
}

export function getApiToken(id: string): ApiToken | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE id = ?`).get(id) as unknown as Row | undefined;
  return row ? toToken(row) : null;
}

/** Newest first, revoked and expired ones included: the list is also the history. */
export function listApiTokens(): ApiToken[] {
  return (db().prepare(`SELECT ${COLUMNS} FROM api_tokens ORDER BY created_at DESC, rowid DESC`).all() as unknown as Row[]).map(toToken);
}

/** The list with each token's status at `now`, for a page: a render is no place to read the clock. */
export function listApiTokensWithStatus(now: number = Date.now()): (ApiToken & { status: TokenStatus })[] {
  return listApiTokens().map((t) => ({ ...t, status: tokenStatus(t, now) }));
}

/** The token a bearer secret belongs to, by the hash of the secret; null when there is none. Status is the caller's to check. */
export function findApiToken(secret: string): ApiToken | null {
  const hash = hashToken(secret);
  const row = db().prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE token_hash = ?`).get(hash) as unknown as Row | undefined;
  return row && sameHash(row.token_hash, hash) ? toToken(row) : null;
}

/** Revokes at once and for good. False when there is no such token or it was already revoked. */
export function revokeApiToken(id: string, now: number = Date.now()): ApiToken | null {
  const token = getApiToken(id);
  if (!token) return null;
  const changed = db().prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes;
  return Number(changed) > 0 ? { ...token, revokedAt: now } : null;
}

/** Records a use, at most once a minute per token. */
export function touchApiToken(id: string, ip: string, now: number = Date.now()): void {
  db()
    .prepare("UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)")
    .run(now, ip, id, now - TOUCH_EVERY_MS);
}
