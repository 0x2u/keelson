import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// API tokens, without the database: the format, the hash, what a token may do. See lib/api-tokens.ts for the storage
// and lib/api-auth.ts for the request check.

export type ApiScope = "read" | "deploy";

export const TOKEN_PREFIX = "kst_";
/** "kst_" and 32 random bytes in base64url: 43 characters. */
const TOKEN_PATTERN = /^kst_[A-Za-z0-9_-]{43}$/;
/** What the list shows to recognise a token: "kst_" and the first four characters of the secret part. */
export const PREFIX_LENGTH = 8;

export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 365;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const NAME_MAX = 60;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** The only form in which a token is stored and looked up: the hex SHA-256 of the whole token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LENGTH);
}

/** The token in an `Authorization: Bearer` header, or null when the header is missing or is not a Keelson token. */
export function parseBearer(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!match) return null;
  return TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** Compares two hex hashes without leaking where they differ. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A token as stored (never the secret itself). */
export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scope: ApiScope;
  /** Server ids the token is limited to; null = every server. */
  servers: string[] | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revokedAt: number | null;
}

export type TokenStatus = "active" | "expired" | "revoked";

export function tokenStatus(t: Pick<ApiToken, "expiresAt" | "revokedAt">, now: number): TokenStatus {
  if (t.revokedAt !== null) return "revoked";
  return t.expiresAt <= now ? "expired" : "active";
}

export type Refusal = { ok: true } | { ok: false; reason: string };

/** Whether a token may do something needing `scope` (deploy implies read), on `serverId` when the call is about one. */
export function tokenAllows(t: Pick<ApiToken, "scope" | "servers">, scope: ApiScope, serverId?: string): Refusal {
  if (scope === "deploy" && t.scope !== "deploy") return { ok: false, reason: "this token has the read scope; deploying, rolling back and running jobs need the deploy scope" };
  if (serverId !== undefined && t.servers !== null && !t.servers.includes(serverId)) return { ok: false, reason: "this token is not allowed on that server" };
  return { ok: true };
}

export interface NewTokenInput {
  name: string;
  scope: string;
  /** null or empty = every server. */
  servers: string[] | null;
  days: number;
}

export interface NewTokenValues {
  name: string;
  scope: ApiScope;
  servers: string[] | null;
  days: number;
}

/** The validated values, or the message to show. Server ids are checked against the registry by the caller. */
export function validateNewToken(input: NewTokenInput): { ok: true; values: NewTokenValues } | { ok: false; error: string } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > NAME_MAX) return { ok: false, error: `The name must be between 1 and ${NAME_MAX} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "The name cannot contain control characters." };
  if (input.scope !== "read" && input.scope !== "deploy") return { ok: false, error: "Choose read or deploy." };
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_EXPIRY_DAYS) {
    return { ok: false, error: `The expiry must be a whole number of days between 1 and ${MAX_EXPIRY_DAYS}.` };
  }
  const servers = input.servers === null || input.servers.length === 0 ? null : [...new Set(input.servers)];
  return { ok: true, values: { name, scope: input.scope, servers, days: input.days } };
}
