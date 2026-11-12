import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  generateToken,
  hashToken,
  parseBearer,
  sameHash,
  tokenAllows,
  tokenStatus,
  validateNewToken,
} from "@/lib/api-tokens-core";
import { mcpConfig } from "@/lib/mcp-config";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-api-tokens-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db, SCHEMA_VERSION, openDatabase } = await import("@/lib/db");
const tokens = await import("@/lib/api-tokens");
const store = await import("@/lib/auth/store");

beforeEach(() => {
  db().exec("DELETE FROM api_tokens");
  db().exec("DELETE FROM audit_log");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;
const make = (over: Partial<{ name: string; scope: "read" | "deploy"; servers: string[] | null; days: number }> = {}, now = NOW) =>
  tokens.createApiToken({ name: "ci", scope: "read", servers: null, days: 30, ...over }, now);

describe("the token", () => {
  it("is kst_ and 43 base64url characters of 32 random bytes, different every time", () => {
    const a = generateToken();
    expect(a).toMatch(/^kst_[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("is found by the SHA-256 hex of the whole token, and the hash does not show the token", () => {
    const token = "kst_" + "A".repeat(43);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(token.slice(0, -1) + "B"));
    expect(sameHash(hashToken(token), hashToken(token))).toBe(true);
    expect(sameHash(hashToken(token), hashToken(token + "x"))).toBe(false);
    expect(sameHash("ab", "abc")).toBe(false);
  });

  it("is read from an Authorization: Bearer header, and only a well-formed one", () => {
    const token = generateToken();
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer ${token}`)).toBe(token);
    for (const bad of [null, "", token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Bearer kst_${"!".repeat(43)}`, `Bearer ${token} extra`, "Bearer ", "Bearer sk_" + "A".repeat(43)]) {
      expect(parseBearer(bad), String(bad)).toBeNull();
    }
  });
});

describe("storage", () => {
  it("keeps the hash and the 8-character prefix, never the token, in any column", () => {
    const { token, record } = make();
    expect(record.prefix).toBe(token.slice(0, 8));
    const row = db().prepare("SELECT * FROM api_tokens").get() as Record<string, unknown>;
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(8));
    expect(JSON.stringify(tokens.listApiTokens())).not.toContain(token.slice(8));
  });

  it("looks a token up by its secret, and an altered or unknown secret finds nothing", () => {
    const { token, record } = make({ name: "one" });
    expect(tokens.findApiToken(token)?.id).toBe(record.id);
    expect(tokens.findApiToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(tokens.findApiToken(generateToken())).toBeNull();
  });

  it("sets the expiry from the days asked, and stores the server limit", () => {
    const { record } = make({ days: 7, servers: ["a", "b"] }, NOW);
    expect(record.expiresAt).toBe(NOW + 7 * DAY_MS);
    expect(record.servers).toEqual(["a", "b"]);
    expect(make({ name: "all" }).record.servers).toBeNull();
  });

  it("refuses a second active token with the same name (any case), but allows the name again once it is revoked", () => {
    const first = make({ name: "CI" });
    expect(() => make({ name: "ci" })).toThrow(tokens.DuplicateTokenNameError);
    tokens.revokeApiToken(first.record.id, NOW + 1);
    expect(() => make({ name: "ci" })).not.toThrow();
  });

  it("lists newest first, with revoked and expired ones", () => {
    make({ name: "old" }, NOW);
    const revoked = make({ name: "mid" }, NOW + 1000);
    make({ name: "new" }, NOW + 2000);
    tokens.revokeApiToken(revoked.record.id, NOW + 3000);
    expect(tokens.listApiTokens().map((t) => [t.name, t.revokedAt !== null])).toEqual([
      ["new", false],
      ["mid", true],
      ["old", false],
    ]);
  });
});

describe("expiry and revocation", () => {
  it("is active until the expiry instant, then expired", () => {
    const { record } = make({ days: 1 }, NOW);
    expect(tokenStatus(record, NOW)).toBe("active");
    expect(tokenStatus(record, NOW + DAY_MS - 1)).toBe("active");
    expect(tokenStatus(record, NOW + DAY_MS)).toBe("expired");
  });

  it("revokes at once and for good, and a second revoke does nothing", () => {
    const { record } = make();
    const revoked = tokens.revokeApiToken(record.id, NOW + 5);
    expect(revoked?.revokedAt).toBe(NOW + 5);
    expect(tokenStatus(tokens.getApiToken(record.id)!, NOW + 6)).toBe("revoked");
    expect(tokens.revokeApiToken(record.id, NOW + 9)).toBeNull();
    expect(tokens.getApiToken(record.id)?.revokedAt).toBe(NOW + 5);
    expect(tokens.revokeApiToken("nope")).toBeNull();
  });
});

describe("last use", () => {
  it("is written at most once a minute per token, with the address of the call it was written for", () => {
    const { record } = make();
    tokens.touchApiToken(record.id, "1.1.1.1", NOW);
    tokens.touchApiToken(record.id, "2.2.2.2", NOW + 30_000);
    expect(tokens.getApiToken(record.id)).toMatchObject({ lastUsedAt: NOW, lastUsedIp: "1.1.1.1" });
    tokens.touchApiToken(record.id, "3.3.3.3", NOW + 60_000);
    expect(tokens.getApiToken(record.id)).toMatchObject({ lastUsedAt: NOW + 60_000, lastUsedIp: "3.3.3.3" });
  });
});

describe("what a token may do", () => {
  it("lets read reach reads only, and deploy reach everything", () => {
    expect(tokenAllows({ scope: "read", servers: null }, "read")).toEqual({ ok: true });
    expect(tokenAllows({ scope: "deploy", servers: null }, "read")).toEqual({ ok: true });
    expect(tokenAllows({ scope: "deploy", servers: null }, "deploy")).toEqual({ ok: true });
    const refused = tokenAllows({ scope: "read", servers: null }, "deploy");
    expect(refused.ok).toBe(false);
  });

  it("limits a token to its servers, and no limit means all", () => {
    expect(tokenAllows({ scope: "read", servers: ["a"] }, "read", "a")).toEqual({ ok: true });
    expect(tokenAllows({ scope: "read", servers: ["a"] }, "read", "b").ok).toBe(false);
    expect(tokenAllows({ scope: "read", servers: [] }, "read", "a").ok).toBe(false);
    expect(tokenAllows({ scope: "read", servers: null }, "read", "zzz")).toEqual({ ok: true });
  });
});

describe("a new token's values", () => {
  const input = { name: "ci", scope: "read", servers: null as string[] | null, days: DEFAULT_EXPIRY_DAYS };

  it("accepts the defaults, trims the name, and reads an empty server list as all", () => {
    expect(validateNewToken({ ...input, name: "  ci  ", servers: [] })).toEqual({ ok: true, values: { name: "ci", scope: "read", servers: null, days: 30 } });
  });

  it("requires an expiry of 1 to 365 whole days", () => {
    expect(validateNewToken({ ...input, days: MAX_EXPIRY_DAYS }).ok).toBe(true);
    expect(validateNewToken({ ...input, days: 1 }).ok).toBe(true);
    for (const days of [0, -1, MAX_EXPIRY_DAYS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(validateNewToken({ ...input, days }).ok, String(days)).toBe(false);
  });

  it("requires a name of 1 to 60 characters and a known scope", () => {
    expect(validateNewToken({ ...input, name: "  " }).ok).toBe(false);
    expect(validateNewToken({ ...input, name: "x".repeat(61) }).ok).toBe(false);
    expect(validateNewToken({ ...input, name: "a\nb" }).ok).toBe(false);
    expect(validateNewToken({ ...input, scope: "admin" }).ok).toBe(false);
    expect(validateNewToken({ ...input, scope: "deploy" }).ok).toBe(true);
  });
});

describe("the MCP configuration", () => {
  it("names the dashboard and the token, under the variables the MCP server reads", () => {
    const parsed = JSON.parse(mcpConfig("https://keelson.example.com", "kst_x")) as { mcpServers: { keelson: { command: string; args: string[]; env: Record<string, string> } } };
    expect(parsed.mcpServers.keelson.env).toEqual({ KEELSON_URL: "https://keelson.example.com", KEELSON_TOKEN: "kst_x" });
    expect(parsed.mcpServers.keelson.command).toBe("node");
  });
});

describe("the audit trail", () => {
  it("keeps who did it next to what, and nothing for the operator's own lines", () => {
    store.audit("login", "password", "1.1.1.1");
    store.audit("api_deploy", "server=prod app=shop outcome=accepted", "2.2.2.2", "token:ci");
    expect(store.recentAudit(5).map((e) => [e.event, e.actor])).toEqual([
      ["api_deploy", "token:ci"],
      ["login", null],
    ]);
  });
});

describe("the schema upgrade", () => {
  it("adds the tokens table and the audit actor to the version before them (8), keeping the audit rows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.join(dir, "before-tokens.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT);
      INSERT INTO audit_log (at, event, detail, ip) VALUES (5, 'login', 'password', '1.1.1.1');
      -- later migrations add columns to servers and to app_repos
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      CREATE TABLE app_repos (server_id TEXT, app TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY); -- a later migration adds the step-up column to it
      PRAGMA user_version = 8;
    `);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("SELECT event, detail, ip, actor FROM audit_log").all()).toEqual([{ event: "login", detail: "password", ip: "1.1.1.1", actor: null }]);
      expect((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      const insert = upgraded.prepare("INSERT INTO api_tokens (id, name, token_hash, prefix, scope, created_at, expires_at) VALUES (?, ?, ?, 'kst_abcd', ?, 1, 2)");
      insert.run("1", "a", "h1", "read");
      expect(() => insert.run("2", "b", "h1", "read")).toThrow(); // the hash is unique
      expect(() => insert.run("3", "c", "h3", "admin")).toThrow(); // the scope is read or deploy
      expect(() => upgraded.exec("INSERT INTO api_tokens (id, name, token_hash, prefix, scope, created_at) VALUES ('4', 'd', 'h4', 'kst_abcd', 'read', 1)")).toThrow(); // an expiry is required
    } finally {
      upgraded.close();
    }
  });
});
