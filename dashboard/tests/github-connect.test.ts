import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-connect-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let session: { id: string } | null = { id: "session-1" };
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!session) throw new Error("redirect to /login");
  },
  currentSession: async () => session,
  hasSession: async () => session !== null,
  clientInfo: async () => ({ ip: "198.51.100.4" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);

const { db } = await import("@/lib/db");
const connect = await import("@/lib/github-connect");
const { startGithubConnectAction, refreshInstallationsAction } = await import("@/app/github-connect-actions");
const { GET } = await import("@/app/api/github/app/callback/route");
const integrations = await import("@/lib/integrations");
const store = await import("@/lib/auth/store");
const { STATE_TTL_MS } = await import("@/lib/github-connect-core");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = "operator-password-1";
const ORIGIN = "https://keelson.example.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const PEM = keys.privateKey;
const SECRET = "whsec_from_github_1234567890";
const CLIENT_SECRET = "client-secret-from-github";

beforeEach(() => {
  resetStepUp();
  for (const table of ["integrations", "audit_log", "github_app_states", "login_failures"]) db().exec(`DELETE FROM ${table}`);
  session = { id: "session-1" };
  process.env.KEELSON_PUBLIC_URL = ORIGIN;
  delete process.env.KEELSON_INSECURE_COOKIES;
  vi.unstubAllGlobals();
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const valid = { name: "Keelson test", account: "user" };
const start = (over: Record<string, string> = {}) => startGithubConnectAction({}, form({ ...valid, ...over }));
const stateOf = (action: string) => new URL(action).searchParams.get("state")!;
const stateRows = () => db().prepare("SELECT * FROM github_app_states").all();

/** A GitHub that exchanges a code; `status` makes it refuse. Records what it was asked. */
function stubConversion(status = 200, over: Record<string, unknown> = {}) {
  const asked: { url: string; method: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    asked.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    if (status !== 200) return new Response('{"message":"Not Found"}', { status });
    return Response.json({
      id: 4242,
      slug: "keelson-test",
      name: "Keelson test",
      owner: { login: "me", type: "User" },
      pem: PEM,
      webhook_secret: SECRET,
      client_id: "Iv1.abc",
      client_secret: CLIENT_SECRET,
      ...over,
    });
  });
  return asked;
}

const callback = (query: string, init?: RequestInit) => GET(new Request(`http://internal:3000/api/github/app/callback?${query}`, init));
async function begin(): Promise<string> {
  const out = await start();
  expect(out.error).toBeUndefined();
  return stateOf(out.start!.action);
}
const location = (res: Response) => res.headers.get("location");

describe("the single-use state", () => {
  it("is 32 random bytes, stored only as a hash, bound to the session, for ten minutes", () => {
    const state = connect.createConnectState("s1", 1000);
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    const [row] = stateRows() as { hash: string; session_id: string; expires_at: number }[];
    expect(row!.session_id).toBe("s1");
    expect(row!.expires_at).toBe(1000 + STATE_TTL_MS);
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stateRows())).not.toContain(state);
    expect(connect.createConnectState("s2", 1000)).not.toBe(state);
  });

  it("is consumed once: the second use finds nothing", () => {
    const state = connect.createConnectState("s1", 1000);
    expect(connect.consumeConnectState(state, "s1", 2000)).toBe("ok");
    expect(connect.consumeConnectState(state, "s1", 2000)).toBe("bad_state");
    expect(stateRows()).toEqual([]);
  });

  it("expires after ten minutes, and the expired row is gone", () => {
    const state = connect.createConnectState("s1", 1000);
    expect(connect.consumeConnectState(state, "s1", 1000 + STATE_TTL_MS)).toBe("expired_state");
    expect(stateRows()).toEqual([]);
    const fresh = connect.createConnectState("s1", 5000);
    expect(connect.consumeConnectState(fresh, "s1", 5000 + STATE_TTL_MS - 1)).toBe("ok");
  });

  it("refuses another session's state, and burns it", () => {
    const state = connect.createConnectState("s1", 1000);
    expect(connect.consumeConnectState(state, "s2", 2000)).toBe("other_session");
    expect(connect.consumeConnectState(state, "s1", 2000)).toBe("bad_state");
  });

  it("refuses a state nobody created", () => {
    expect(connect.consumeConnectState("nope", "s1")).toBe("bad_state");
  });

  it("keeps one pending state per session (a new attempt replaces the old) and sweeps the expired ones", () => {
    const first = connect.createConnectState("s1", 1000);
    connect.createConnectState("other", 1000);
    const second = connect.createConnectState("s1", 2000);
    expect(connect.consumeConnectState(first, "s1", 2000)).toBe("bad_state");
    expect(connect.consumeConnectState(second, "s1", 2000)).toBe("ok");
    connect.createConnectState("s3", 1000 + STATE_TTL_MS + 1);
    expect(stateRows()).toHaveLength(1);
  });
});

describe("starting the flow", () => {
  it("returns the manifest and a GitHub address with the state, for the account, and audits the start", async () => {
    const out = await start();
    expect(out.error).toBeUndefined();
    expect(out.start!.action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[A-Za-z0-9_-]{43}$/);
    const manifest = JSON.parse(out.start!.manifest);
    expect(manifest).toMatchObject({
      name: "Keelson test",
      url: ORIGIN,
      redirect_url: `${ORIGIN}/api/github/app/callback`,
      hook_attributes: { url: `${ORIGIN}/api/webhooks/github`, active: true },
      setup_url: `${ORIGIN}/settings/integrations?github=installed`,
      setup_on_update: true,
      public: false,
      default_permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read" },
      default_events: ["push", "pull_request"],
    });
    expect(stateRows()).toHaveLength(1);
    const [line] = store.recentAudit(5);
    expect(line).toMatchObject({ event: "github_app_connect_started", ip: "198.51.100.4" });
    expect(line!.detail).not.toContain(stateOf(out.start!.action));
  });

  it("posts to the organization's page for an organization, and checks its login", async () => {
    const out = await start({ account: "org", org: "acme-corp" });
    expect(out.start!.action).toMatch(/^https:\/\/github\.com\/organizations\/acme-corp\/settings\/apps\/new\?state=/);
    const bad = await start({ account: "org", org: "../evil" });
    expect(bad.error).toMatch(/organization/);
    expect(bad.start).toBeUndefined();
  });

  it("refuses without a public https address, saying what to set, and creates no state", async () => {
    delete process.env.KEELSON_PUBLIC_URL;
    expect((await start()).error).toContain("KEELSON_PUBLIC_URL");
    process.env.KEELSON_PUBLIC_URL = "http://keelson.example.com";
    expect((await start()).error).toContain("https");
    expect(stateRows()).toEqual([]);
  });

  it("allows http on localhost only for development", async () => {
    process.env.KEELSON_PUBLIC_URL = "http://localhost:3000";
    expect((await start()).error).toBeDefined();
    process.env.KEELSON_INSECURE_COOKIES = "true";
    const out = await start();
    expect(JSON.parse(out.start!.manifest).redirect_url).toBe("http://localhost:3000/api/github/app/callback");
  });

  it("rejects a bad name and needs a session", async () => {
    expect((await start({ name: "" })).error).toMatch(/name/);
    session = null;
    await expect(start()).rejects.toBeInstanceOf(Error);
    expect(stateRows()).toEqual([]);
  });

  it("is refused until the session is unlocked: a stolen session cannot bind an App of its own, and no state is created", async () => {
    state.locked = true;
    expect(isStepUpError((await start()).error)).toBe(true);
    expect(stateRows()).toEqual([]);
    state.locked = false;
    expect((await start()).start).toBeDefined();
  });
});

describe("replacing an existing App", () => {
  const existing = () => integrations.saveGithubApp({ appId: "1", slug: "old-app", privateKey: PEM });

  it("needs the explicit confirmation, then the password, and creates no state until both are given", async () => {
    existing();
    expect((await start()).error).toMatch(/Confirm/);
    expect((await start({ confirmReplace: "on" })).error).toBe("Enter your current password to confirm.");
    expect((await start({ confirmReplace: "on", password: "wrong" })).error).toBe("Wrong password.");
    expect(stateRows()).toEqual([]);
    expect(store.recentAudit(5).some((e) => e.event === "security_confirm_failed")).toBe(true);
    const ok = await start({ confirmReplace: "on", password: PASSWORD });
    expect(ok.start).toBeDefined();
    expect(stateRows()).toHaveLength(1);
    expect(store.recentAudit(1)[0]!.detail).toContain("replacing");
  });

  it("applies also when only a webhook secret exists, and not when nothing exists", async () => {
    integrations.saveWebhookSecret("old-secret");
    expect((await start()).error).toMatch(/Confirm/);
    db().exec("DELETE FROM integrations");
    expect((await start()).start).toBeDefined();
  });

  it("is throttled like the other password confirmations", async () => {
    existing();
    for (let i = 0; i < 5; i++) await start({ confirmReplace: "on", password: "wrong" });
    expect((await start({ confirmReplace: "on", password: PASSWORD })).error).toMatch(/Too many/);
  });

  it("does not touch the stored App or secret by itself", async () => {
    existing();
    integrations.saveWebhookSecret("old-secret");
    await start({ confirmReplace: "on", password: PASSWORD });
    expect(integrations.githubAppCredentials()).toEqual({ appId: "1", privateKey: PEM });
    expect(integrations.webhookSecret()).toBe("old-secret");
  });
});

describe("the callback", () => {
  it("stores the App ID, slug, name, owner and key (encrypted), and GitHub's webhook secret as the dashboard's, then sends the operator to install it", async () => {
    const asked = stubConversion();
    const state = await begin();
    const res = await callback(`code=abcdef1234567890&state=${state}`);
    expect(res.status).toBe(303);
    expect(location(res)).toBe("https://github.com/apps/keelson-test/installations/new");

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ url: "https://api.github.com/app-manifests/abcdef1234567890/conversions", method: "POST" });
    expect(asked[0]!.headers).not.toHaveProperty("Authorization");

    expect(integrations.githubAppSummary()).toMatchObject({ appId: "4242", slug: "keelson-test", name: "Keelson test", owner: { login: "me", type: "User" } });
    expect(integrations.githubAppCredentials()).toEqual({ appId: "4242", privateKey: PEM });
    expect(integrations.webhookSecret()).toBe(SECRET);
    expect(integrations.webhookSecretSince()).not.toBeNull();
    const raw = JSON.stringify(db().prepare("SELECT * FROM integrations").all());
    for (const secret of [PEM.slice(40, 120), SECRET, CLIENT_SECRET, "Iv1.abc"]) expect(raw).not.toContain(secret);
    expect(stateRows()).toEqual([]);
  });

  it("leaves no secret in the response, the redirect or the audit log, and audits each step", async () => {
    stubConversion();
    const state = await begin();
    const res = await callback(`code=abcdef1234567890&state=${state}`);
    const everything = JSON.stringify([...res.headers.entries()]) + (await res.text()) + JSON.stringify(store.recentAudit(50));
    for (const secret of [PEM.slice(40, 120), SECRET, CLIENT_SECRET, "Iv1.abc", state]) expect(everything).not.toContain(secret);
    expect(store.recentAudit(10).map((e) => e.event)).toEqual(["github_app_created", "github_app_connect_started"]);
    expect(store.recentAudit(1)[0]!.detail).toContain("4242");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("replaces the previous App and the manual webhook secret, and says so in the audit", async () => {
    integrations.saveGithubApp({ appId: "1", slug: "old-app", privateKey: PEM });
    integrations.saveWebhookSecret("manual-secret");
    stubConversion();
    const out = await start({ confirmReplace: "on", password: PASSWORD });
    await callback(`code=abcdef1234567890&state=${stateOf(out.start!.action)}`);
    expect(integrations.githubAppSummary()?.appId).toBe("4242");
    expect(integrations.webhookSecret()).toBe(SECRET);
    expect(store.recentAudit(1)[0]!.detail).toContain("replacing");
  });

  it("refuses a state used before: the code is not even sent to GitHub the second time", async () => {
    const asked = stubConversion();
    const state = await begin();
    await callback(`code=abcdef1234567890&state=${state}`);
    const again = await callback(`code=abcdef1234567890&state=${state}`);
    expect(location(again)).toBe(`${ORIGIN}/settings/integrations?github_error=bad_state`);
    expect(asked).toHaveLength(1);
  });

  it("refuses a missing or malformed state or code", async () => {
    const asked = stubConversion();
    for (const q of ["", "code=abcdef1234567890", "state=xxxxxxxxxxxxxxxxxxxx", "code=../../x&state=" + "a".repeat(43)]) {
      expect(location(await callback(q)), q).toBe(`${ORIGIN}/settings/integrations?github_error=no_state`);
    }
    expect(asked).toHaveLength(0);
  });

  it("refuses an expired state, and a state another session started, without storing anything", async () => {
    const asked = stubConversion();
    const state = await begin();
    db().prepare("UPDATE github_app_states SET expires_at = ?").run(Date.now() - 1);
    expect(location(await callback(`code=abcdef1234567890&state=${state}`))).toBe(`${ORIGIN}/settings/integrations?github_error=expired_state`);

    const other = await begin();
    session = { id: "session-2" };
    expect(location(await callback(`code=abcdef1234567890&state=${other}`))).toBe(`${ORIGIN}/settings/integrations?github_error=other_session`);
    session = { id: "session-1" };
    expect(location(await callback(`code=abcdef1234567890&state=${other}`))).toContain("github_error=bad_state");
    expect(asked).toHaveLength(0);
    expect(integrations.githubAppSummary()).toBeNull();
    expect(store.recentAudit(10).filter((e) => e.event === "github_app_connect_failed")).toHaveLength(3);
  });

  it.each([
    [404, "refused"],
    [422, "refused"],
    [500, "github_error"],
  ] as const)("shows GitHub's refusal (status %i) as %s and stores nothing", async (status, code) => {
    stubConversion(status);
    const state = await begin();
    const res = await callback(`code=abcdef1234567890&state=${state}`);
    expect(location(res)).toBe(`${ORIGIN}/settings/integrations?github_error=${code}`);
    expect(integrations.githubAppSummary()).toBeNull();
    expect(integrations.webhookSecretSince()).toBeNull();
  });

  it("reports an unreachable GitHub, and an answer that is not an App", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("ENETUNREACH")));
    expect(location(await callback(`code=abcdef1234567890&state=${await begin()}`))).toContain("github_error=unreachable");
    stubConversion(200, { pem: "not a key" });
    expect(location(await callback(`code=abcdef1234567890&state=${await begin()}`))).toContain("github_error=bad_answer");
    stubConversion(200, { webhook_secret: undefined });
    expect(location(await callback(`code=abcdef1234567890&state=${await begin()}`))).toContain("github_error=bad_answer");
    expect(integrations.githubAppSummary()).toBeNull();
  });

  it("says there is no public address instead of doing anything", async () => {
    const asked = stubConversion();
    const state = await begin();
    delete process.env.KEELSON_PUBLIC_URL;
    const res = await callback(`code=abcdef1234567890&state=${state}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("KEELSON_PUBLIC_URL");
    expect(asked).toHaveLength(0);
  });

  it("without a session first continues to the same address (the SameSite=Strict cookie does not accompany a navigation from github.com), then refuses", async () => {
    const asked = stubConversion();
    const state = await begin();
    session = null;
    const first = await callback(`code=abcdef1234567890&state=${state}`);
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain(`url=/api/github/app/callback?code=abcdef1234567890&#38;state=${state}&#38;hop=1`);
    // Nothing was consumed or sent: the continuation is the same request with a cookie.
    expect(stateRows()).toHaveLength(1);
    const second = await callback(`code=abcdef1234567890&state=${state}&hop=1`);
    expect(second.status).toBe(401);
    expect(await second.text()).toContain("Sign in");
    expect(stateRows()).toHaveLength(1);
    expect(asked).toHaveLength(0);
    expect(integrations.githubAppSummary()).toBeNull();
    // With the session back, the same continuation completes.
    session = { id: "session-1" };
    expect((await callback(`code=abcdef1234567890&state=${state}&hop=1`)).status).toBe(303);
  });

  it("does not echo anything from the request into the continuation page", async () => {
    session = null;
    const html = await (await callback(`code="><script>alert(1)</script>&state=x&other=y`)).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("other=y");
  });
});

describe("refreshing", () => {
  it("needs a session", async () => {
    session = null;
    await expect(refreshInstallationsAction()).rejects.toBeInstanceOf(Error);
  });
});

describe("the schema upgrade", () => {
  it("adds the states table to a database at the version before it, leaving the rest alone", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase, SCHEMA_VERSION } = await import("@/lib/db");
    const file = path.join(dir, "before-states.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT);
      INSERT INTO audit_log (at, event, detail, ip) VALUES (5, 'login', 'password', '1.1.1.1');
      -- later migrations add columns to servers and to app_repos
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      CREATE TABLE app_repos (server_id TEXT, app TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY); -- a later migration adds the step-up column to it
      PRAGMA user_version = 9;
    `);
    old.close();
    const upgraded = openDatabase(file);
    try {
      expect((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(upgraded.prepare("SELECT event FROM audit_log").all()).toEqual([{ event: "login" }]);
      upgraded.prepare("INSERT INTO github_app_states (hash, session_id, created_at, expires_at) VALUES ('h', 's', 1, 2)").run();
      expect(() => upgraded.prepare("INSERT INTO github_app_states (hash, session_id, created_at, expires_at) VALUES ('h', 's2', 1, 2)").run()).toThrow();
    } finally {
      upgraded.close();
    }
  });
});
