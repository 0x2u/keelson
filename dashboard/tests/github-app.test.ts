import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { GithubAppError, InstallationTokens, TOKEN_CACHE_MAX, TOKEN_REUSE_MS, githubAppSlug } = await import("@/lib/github-app");
const integrations = await import("@/lib/integrations");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const CREDENTIALS = { appId: "4242", privateKey: keys.privateKey };
const T0 = 1_800_000_000_000;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A GitHub that knows installations by repository and answers the way the real API does. */
function fakeGithub(over: { installation?: (call: Call) => Response; token?: (call: Call) => Response } = {}) {
  const calls: Call[] = [];
  let minted = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) return over.installation?.(call) ?? Response.json({ id: 77 });
    if (/\/app\/installations\/77\/access_tokens$/.test(url)) return over.token?.(call) ?? Response.json({ token: `ghs_token_${++minted}`, expires_at: "2026-10-21T12:00:00Z" }, { status: 201 });
    if (url.endsWith("/app")) return Response.json({ slug: "my-keelson", name: "My Keelson" });
    return new Response("{}", { status: 404 });
  };
  return { calls, fetch };
}

function client(fake: ReturnType<typeof fakeGithub>, clock: { now: number }, credentials: typeof CREDENTIALS | null = CREDENTIALS) {
  return new InstallationTokens({ fetch: fake.fetch, now: () => clock.now, credentials: () => credentials });
}

describe("installation tokens", () => {
  it("finds the installation with the app JWT, then mints a token for that repository only, with the minimum permissions", async () => {
    const fake = fakeGithub();
    const clock = { now: T0 };
    expect(await client(fake, clock).forRepo("Acme/Shop")).toBe("ghs_token_1");

    expect(fake.calls).toHaveLength(2);
    const [lookup, mint] = fake.calls;
    expect(lookup).toMatchObject({ url: "https://api.github.com/repos/Acme/Shop/installation", method: "GET" });
    expect(mint).toMatchObject({ url: "https://api.github.com/app/installations/77/access_tokens", method: "POST" });
    expect(mint!.body).toEqual({ repositories: ["Shop"], permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read" } });
    for (const call of fake.calls) {
      expect(call.headers.Accept).toBe("application/vnd.github+json");
      expect(call.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(call.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      // The JWT identifies the app and was signed by its key.
      const [h, p, s] = call.headers.Authorization!.slice("Bearer ".length).split(".");
      expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: T0 / 1000 - 60, exp: T0 / 1000 + 540, iss: "4242" });
      expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey(keys.publicKey), Buffer.from(s!, "base64url"))).toBe(true);
    }
  });

  it("reuses a token for the same repository (any letter case) for 50 minutes, then mints a new one", async () => {
    const fake = fakeGithub();
    const clock = { now: T0 };
    const tokens = client(fake, clock);
    expect(await tokens.forRepo("Acme/Shop")).toBe("ghs_token_1");
    clock.now = T0 + TOKEN_REUSE_MS - 1;
    expect(await tokens.forRepo("acme/shop")).toBe("ghs_token_1");
    expect(fake.calls).toHaveLength(2);
    clock.now = T0 + TOKEN_REUSE_MS;
    expect(await tokens.forRepo("Acme/Shop")).toBe("ghs_token_2");
    expect(fake.calls).toHaveLength(4);
  });

  it("keeps a token per repository, and shares one mint between concurrent requests", async () => {
    const fake = fakeGithub();
    const tokens = client(fake, { now: T0 });
    const [a, b, c] = await Promise.all([tokens.forRepo("acme/shop"), tokens.forRepo("acme/shop"), tokens.forRepo("acme/other")]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("forgets everything on clear, and is bounded", async () => {
    const fake = fakeGithub();
    const tokens = client(fake, { now: T0 });
    await tokens.forRepo("acme/shop");
    tokens.clear();
    await tokens.forRepo("acme/shop");
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(2);

    const many = fakeGithub();
    const bounded = client(many, { now: T0 });
    for (let i = 0; i < TOKEN_CACHE_MAX + 5; i++) await bounded.forRepo(`acme/r${i}`);
    expect((bounded as unknown as { cache: Map<string, unknown> }).cache.size).toBeLessThanOrEqual(TOKEN_CACHE_MAX);
    // The oldest was dropped: asking again mints again.
    const before = many.calls.length;
    await bounded.forRepo("acme/r0");
    expect(many.calls.length).toBe(before + 2);
  });

  it("asks for Actions: read only when the runs are wanted, keeps that token apart, and says what to change when the App lacks it", async () => {
    const fake = fakeGithub();
    const tokens = client(fake, { now: T0 });
    await tokens.forRepo("Acme/Shop");
    await tokens.forRepo("Acme/Shop", true);
    const mints = fake.calls.filter((c) => c.method === "POST");
    expect(mints).toHaveLength(2);
    expect(mints[0]!.body).toEqual({ repositories: ["Shop"], permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read" } });
    expect(mints[1]!.body).toEqual({ repositories: ["Shop"], permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read", actions: "read" } });

    const refused = fakeGithub({ token: () => new Response("{}", { status: 422 }) });
    const err = await client(refused, { now: T0 }).forRepo("acme/shop", true).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Actions to Read-only/);
  });

  it("says clearly why it failed, never caches a failure, and never includes a token or the key in the message", async () => {
    const cases: [string, { installation?: (c: Call) => Response; token?: (c: Call) => Response }, RegExp][] = [
      ["no installation", { installation: () => new Response("{}", { status: 404 }) }, /not installed on acme\/shop/],
      ["bad credentials", { installation: () => new Response("{}", { status: 401 }) }, /rejected the App's credentials/],
      ["bad credentials at the token", { token: () => new Response("{}", { status: 401 }) }, /rejected the App's credentials/],
      ["permissions not accepted", { token: () => new Response("{}", { status: 422 }) }, /does not grant what Keelson needs/],
      ["forbidden", { token: () => new Response("{}", { status: 403 }) }, /does not grant what Keelson needs/],
      ["a server error", { installation: () => new Response("{}", { status: 502 }) }, /status 502/],
      ["an unexpected answer", { installation: () => Response.json({ nope: true }) }, /not what was expected/],
      ["a token answer without a token", { token: () => Response.json({}, { status: 201 }) }, /not what was expected/],
    ];
    for (const [label, over, message] of cases) {
      const fake = fakeGithub(over);
      const tokens = client(fake, { now: T0 });
      const err = await tokens.forRepo("acme/shop").catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(GithubAppError);
      expect((err as Error).message, label).toMatch(message);
      expect((err as Error).message, label).not.toContain("BEGIN");
      const retry = await tokens.forRepo("acme/shop").catch((e: unknown) => e);
      expect(retry, label).toBeInstanceOf(GithubAppError);
      expect(fake.calls.length, label).toBeGreaterThan(1); // asked again: the failure was not cached
    }
  });

  it("reports an unreachable GitHub, an unconfigured App, a bad repository name and a broken key", async () => {
    const down = new InstallationTokens({ fetch: async () => Promise.reject(new TypeError("fetch failed")), now: () => T0, credentials: () => CREDENTIALS });
    await expect(down.forRepo("acme/shop")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Could not reach api.github.com") });
    await expect(client(fakeGithub(), { now: T0 }, null).forRepo("acme/shop")).rejects.toThrow(/not configured/);
    await expect(client(fakeGithub(), { now: T0 }).forRepo("not a repo")).rejects.toThrow(/not a GitHub repository/);
    const broken = client(fakeGithub(), { now: T0 }, { appId: "1", privateKey: "garbage" });
    await expect(broken.forRepo("acme/shop")).rejects.toThrow(/not a private key in PEM format/);
  });
});

describe("checking the App when its credentials are saved", () => {
  it("reads the slug with the app JWT", async () => {
    const fake = fakeGithub();
    expect(await githubAppSlug("4242", keys.privateKey, { fetch: fake.fetch, now: () => T0, credentials: () => CREDENTIALS })).toBe("my-keelson");
    expect(fake.calls[0]).toMatchObject({ url: "https://api.github.com/app", method: "GET" });
    expect(fake.calls[0]!.headers.Authorization).toMatch(/^Bearer /);
  });

  it("explains a rejection", async () => {
    const deps = { fetch: async () => new Response("{}", { status: 401 }), now: () => T0, credentials: () => CREDENTIALS };
    await expect(githubAppSlug("4242", keys.privateKey, deps)).rejects.toThrow(/rejected the App's credentials/);
  });
});

describe("the tokens are never persisted or logged", () => {
  beforeEach(() => {
    for (const table of ["integrations", "app_repos", "audit_log"]) db().exec(`DELETE FROM ${table}`);
  });
  afterEach(() => vi.restoreAllMocks());

  it("leaves no installation token in the database nor in the console", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: keys.privateKey });
    const tokens = new InstallationTokens({ fetch: fakeGithub().fetch, now: () => T0, credentials: integrations.githubAppCredentials });
    const token = await tokens.forRepo("acme/shop");
    expect(token).toBe("ghs_token_1");
    const dump = JSON.stringify(db().prepare("SELECT * FROM integrations").all()) + JSON.stringify(db().prepare("SELECT * FROM audit_log").all());
    expect(dump).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});

describe("the stored App", () => {
  beforeEach(() => {
    for (const table of ["integrations", "app_repos"]) db().exec(`DELETE FROM ${table}`);
  });

  it("keeps the private key encrypted and never hands it back in the summary", () => {
    expect(integrations.githubAppSummary()).toBeNull();
    expect(integrations.githubAppCredentials()).toBeNull();
    integrations.saveGithubApp({ appId: "4242", slug: null, privateKey: keys.privateKey });
    const summary = integrations.githubAppSummary();
    expect(summary).toMatchObject({ appId: "4242", slug: null });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE KEY");
    const row = db().prepare("SELECT token_enc, account FROM integrations WHERE provider = 'github-app'").get() as { token_enc: string; account: string };
    expect(row.token_enc.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");
    expect(integrations.githubAppCredentials()).toEqual({ appId: "4242", privateKey: keys.privateKey });
    // Replacing keeps one row.
    integrations.saveGithubApp({ appId: "4243", slug: "x", privateKey: keys.privateKey });
    expect(db().prepare("SELECT count(*) AS n FROM integrations WHERE provider = 'github-app'").get()).toEqual({ n: 1 });
    expect(integrations.githubAppSummary()).toMatchObject({ appId: "4243", slug: "x" });
  });

  it("turns every app's builds off when it is removed", () => {
    db().exec("INSERT INTO servers (id, name, url, token_enc, created_at, updated_at) VALUES ('s', 's', 'https://x', 't', 1, 1)");
    try {
      integrations.saveGithubApp({ appId: "1", slug: null, privateKey: keys.privateKey });
      integrations.setAppRepo("s", "shop", { repo: "a/b", branch: "main" });
      integrations.setBuildModes("s", "shop", { onPush: true, previews: true });
      expect(integrations.getAppRepo("s", "shop")).toMatchObject({ buildOnPush: true, buildPreviews: true });
      integrations.removeGithubApp();
      expect(integrations.githubAppSummary()).toBeNull();
      expect(integrations.getAppRepo("s", "shop")).toMatchObject({ buildOnPush: false, buildPreviews: false });
    } finally {
      db().exec("DELETE FROM app_repos; DELETE FROM servers");
    }
  });

  it("resets the modes when the app is linked to another repository or branch, and keeps them for the same link", () => {
    db().exec("INSERT INTO servers (id, name, url, token_enc, created_at, updated_at) VALUES ('s', 's', 'https://x', 't', 1, 1)");
    try {
      integrations.setAppRepo("s", "shop", { repo: "a/b", branch: "main" });
      integrations.setBuildModes("s", "shop", { onPush: true, previews: false });
      integrations.setAppRepo("s", "shop", { repo: "a/b", branch: "main" });
      expect(integrations.getAppRepo("s", "shop")?.buildOnPush).toBe(true);
      integrations.setAppRepo("s", "shop", { repo: "a/b", branch: "release" });
      expect(integrations.getAppRepo("s", "shop")).toMatchObject({ buildOnPush: false, buildPreviews: false });
      expect(integrations.setBuildModes("s", "nothing", { onPush: true, previews: true })).toBe(false);
    } finally {
      db().exec("DELETE FROM app_repos; DELETE FROM servers");
    }
  });
});
