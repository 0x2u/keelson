import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS } from "@/lib/api-tokens-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-token-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let signedIn = true;
class NotSignedIn extends Error {}
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!signedIn) throw new NotSignedIn("redirect to /login");
  },
  clientInfo: async () => ({ ip: "198.51.100.4" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const actions = await import("@/app/api-token-actions");
const tokens = await import("@/lib/api-tokens");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { authenticate } = await import("@/lib/api-v1");

const PASSWORD = "operator-password-1";
let serverA = "";
let serverB = "";
beforeAll(() => {
  serverA = servers.createServer({ name: "a", url: "https://a.example.com", token: "t".repeat(40) });
  serverB = servers.createServer({ name: "b", url: "https://b.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["api_tokens", "audit_log", "login_failures"]) db().exec(`DELETE FROM ${table}`);
  signedIn = true;
});

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
};
const valid = { name: "ci", scope: "read", limit: "all", days: "30", password: PASSWORD };
const create = (over: Record<string, string | string[]> = {}) => actions.createApiTokenAction({}, form({ ...valid, ...over }));
const call = (token: string) => authenticate(new Request("http://dash/api/v1/servers", { headers: { Authorization: `Bearer ${token}` } }), { scope: "read" });

describe("creating a token", () => {
  it("needs the password again: none, or a wrong one, creates nothing and is counted and audited", async () => {
    expect(await create({ password: "" })).toEqual({ error: "Enter your current password to confirm." });
    expect(await create({ password: "wrong" })).toEqual({ error: "Wrong password." });
    expect(tokens.listApiTokens()).toEqual([]);
    expect(store.recentAudit(5).map((e) => [e.event, e.detail])).toEqual([["security_confirm_failed", "wrong password"]]);
    for (let i = 0; i < 4; i++) await create({ password: "wrong" });
    expect(await create()).toEqual({ error: "Too many failed attempts. Try again in a few minutes." });
    expect(tokens.listApiTokens()).toEqual([]);
  });

  it("needs a signed-in session", async () => {
    signedIn = false;
    await expect(create()).rejects.toBeInstanceOf(Error);
    await expect(actions.revokeApiTokenAction("x")).rejects.toBeInstanceOf(Error);
    expect(tokens.listApiTokens()).toEqual([]);
  });

  it("returns the token once, stores only its hash, and audits the creation without the secret", async () => {
    const state = await create({ name: "claude", scope: "deploy", days: "90" });
    expect(state.error).toBeUndefined();
    const created = state.created!;
    expect(created.token).toMatch(/^kst_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ name: "claude", scope: "deploy", servers: null });
    expect(created.expiresAt).toBeGreaterThan(Date.now() + 89 * DAY_MS);
    expect(created.expiresAt).toBeLessThan(Date.now() + 91 * DAY_MS);
    expect(JSON.stringify(tokens.listApiTokens())).not.toContain(created.token.slice(8));
    expect(call(created.token).ok).toBe(true);
    const [line] = store.recentAudit(5);
    expect(line).toMatchObject({ event: "api_token_created", ip: "198.51.100.4" });
    expect(line.detail).toContain("claude");
    expect(line.detail).toContain("deploy");
    expect(JSON.stringify(store.recentAudit(10))).not.toContain(created.token.slice(8));
  });

  it("limits the token to the servers chosen, and refuses none or unknown ones when limited", async () => {
    const state = await create({ limit: "some", server: [serverA] });
    expect(state.created?.servers).toEqual([serverA]);
    expect(await create({ name: "x", limit: "some" })).toEqual({ error: "Choose at least one server, or let the token use all of them." });
    expect((await create({ name: "y", limit: "some", server: [serverB, "ghost"] })).error).toMatch(/no longer exists/);
    expect(tokens.listApiTokens()).toHaveLength(1);
  });

  it("requires an expiry of 1 to 365 days, a scope, and a name not used by an active token", async () => {
    for (const days of ["0", "366", "", "abc", "1.5"]) expect((await create({ days })).error, days).toMatch(/expiry/);
    expect((await create({ days: "365" })).created).toBeDefined();
    expect((await create({ name: "other", scope: "root" })).error).toBe("Choose read or deploy.");
    expect((await create()).error).toMatch(/already has this name/);
    expect(tokens.listApiTokens()).toHaveLength(1);
  });
});

describe("revoking a token", () => {
  it("takes effect at once and is audited", async () => {
    const { created } = await create();
    expect(call(created!.token).ok).toBe(true);
    const [record] = tokens.listApiTokens();
    await actions.revokeApiTokenAction(record.id);
    expect(call(created!.token).ok).toBe(false);
    expect(store.recentAudit(1)[0]).toMatchObject({ event: "api_token_revoked", ip: "198.51.100.4" });
    expect(store.recentAudit(1)[0].detail).toContain("ci");
    // Revoking again, or something that does not exist, writes nothing more.
    await actions.revokeApiTokenAction(record.id);
    await actions.revokeApiTokenAction("nope");
    expect(store.recentAudit(10).filter((e) => e.event === "api_token_revoked")).toHaveLength(1);
  });
});
