import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-installations-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { GithubAppError, InstalledRepos, REPO_CAP, REPOS_CACHE_MS } = await import("@/lib/github-app");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const CREDENTIALS = { appId: "4242", privateKey: keys.privateKey };
const T0 = 1_800_000_000_000;

interface Call {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}
type Repo = { full_name: string; default_branch?: string; private: boolean; pushed_at?: string };

/**
 * A GitHub with installations, each with repositories; pages are honoured (`per_page`, `page`). An installation's
 * token is `ghs_<id>` so a request made with another installation's token is visible.
 */
function fakeGithub(installations: { id: number; login?: string; suspended?: boolean; tokenStatus?: number; repos: Repo[] }[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const auth = String((init.headers as Record<string, string>).Authorization);
    calls.push({ url, method: init.method ?? "GET", auth, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const page = Number(u.searchParams.get("page") ?? 1);
    const slice = <T>(all: T[]) => all.slice((page - 1) * per, page * per);
    if (u.pathname === "/app/installations") {
      return Response.json(slice(installations.map((i) => ({ id: i.id, account: i.login ? { login: i.login } : null, suspended_at: i.suspended ? "2026-01-01T00:00:00Z" : null }))));
    }
    const mint = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) {
      const inst = installations.find((i) => i.id === Number(mint[1]));
      if (!inst) return new Response("{}", { status: 404 });
      if (inst.tokenStatus) return new Response("{}", { status: inst.tokenStatus });
      return Response.json({ token: `ghs_${inst.id}` }, { status: 201 });
    }
    if (u.pathname === "/installation/repositories") {
      const inst = installations.find((i) => auth === `Bearer ghs_${i.id}`);
      if (!inst) return new Response("{}", { status: 401 });
      return Response.json({ total_count: inst.repos.length, repositories: slice(inst.repos) });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, fetch };
}

const repo = (name: string, over: Partial<Repo> = {}): Repo => ({ full_name: name, default_branch: "main", private: false, ...over });
const lister = (fake: ReturnType<typeof fakeGithub>, clock = { now: T0 }, credentials: typeof CREDENTIALS | null = CREDENTIALS) =>
  new InstalledRepos({ fetch: fake.fetch, now: () => clock.now, credentials: () => credentials });

describe("the repositories the App can reach", () => {
  it("lists every installation with its repositories, newest push first, with branch, privacy and installation", async () => {
    const fake = fakeGithub([
      { id: 1, login: "me", repos: [repo("me/old", { pushed_at: "2026-01-01T00:00:00Z" }), repo("me/new", { pushed_at: "2026-09-01T00:00:00Z", private: true, default_branch: "trunk" })] },
      { id: 2, login: "acme", repos: [repo("acme/mid", { pushed_at: "2026-05-01T00:00:00Z" }), repo("acme/never-pushed", { pushed_at: undefined })] },
    ]);
    const overview = await lister(fake).overview();
    expect(overview.installations).toBe(2);
    expect(overview.truncated).toBe(false);
    expect(overview.repos).toEqual([
      { fullName: "me/new", defaultBranch: "trunk", private: true, installationId: 1 },
      { fullName: "acme/mid", defaultBranch: "main", private: false, installationId: 2 },
      { fullName: "me/old", defaultBranch: "main", private: false, installationId: 1 },
      { fullName: "acme/never-pushed", defaultBranch: "main", private: false, installationId: 2 },
    ]);
  });

  it("asks as the App (JWT) for installations and as each installation for its repositories, with the minimal permissions and no repository filter", async () => {
    const fake = fakeGithub([{ id: 1, repos: [repo("a/b")] }, { id: 2, repos: [repo("c/d")] }]);
    await lister(fake).overview();
    const mints = fake.calls.filter((c) => c.method === "POST");
    expect(mints.map((c) => c.url)).toEqual(["https://api.github.com/app/installations/1/access_tokens", "https://api.github.com/app/installations/2/access_tokens"]);
    for (const m of mints) {
      expect(m.body).toEqual({ permissions: { contents: "read", statuses: "write", pull_requests: "read", metadata: "read" } });
      expect(m.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    }
    const reads = fake.calls.filter((c) => c.url.includes("/installation/repositories"));
    expect(reads.map((c) => c.auth)).toEqual(["Bearer ghs_1", "Bearer ghs_2"]);
    expect(reads[0]!.url).toContain("per_page=100");
    expect(fake.calls[0]!.url).toBe("https://api.github.com/app/installations?per_page=100&page=1");
  });

  it("follows pages of installations and of repositories", async () => {
    const many = Array.from({ length: 230 }, (_, i) => repo(`me/r${i}`, { pushed_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` }));
    const installs = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, repos: i === 0 ? many : [] }));
    const fake = fakeGithub(installs);
    const overview = await lister(fake).overview();
    expect(overview.installations).toBe(120);
    expect(overview.repos).toHaveLength(230);
    expect(new Set(overview.repos.map((r) => r.fullName)).size).toBe(230);
    expect(fake.calls.filter((c) => c.url.startsWith("https://api.github.com/app/installations?"))).toHaveLength(2);
    expect(fake.calls.filter((c) => c.url.includes("/installation/repositories") && c.auth === "Bearer ghs_1")).toHaveLength(3);
  });

  it(`stops at ${REPO_CAP} repositories, says the list is cut, and does not read further installations`, async () => {
    const big = Array.from({ length: 700 }, (_, i) => repo(`me/r${i}`));
    const fake = fakeGithub([{ id: 1, repos: big }, { id: 2, repos: [repo("acme/x")] }]);
    const overview = await lister(fake).overview();
    expect(overview.repos).toHaveLength(REPO_CAP);
    expect(overview.truncated).toBe(true);
    expect(overview.repos.some((r) => r.installationId === 2)).toBe(false);
    expect(fake.calls.some((c) => c.url.includes("/app/installations/2/"))).toBe(false);
  });

  it("skips a suspended installation or one whose permissions are not accepted, and says so", async () => {
    const fake = fakeGithub([
      { id: 1, login: "ok", repos: [repo("ok/a")] },
      { id: 2, login: "paused", suspended: true, repos: [repo("paused/a")] },
      { id: 3, login: "denied", tokenStatus: 403, repos: [repo("denied/a")] },
    ]);
    const overview = await lister(fake).overview();
    expect(overview.installations).toBe(3);
    expect(overview.repos.map((r) => r.fullName)).toEqual(["ok/a"]);
    expect(overview.warnings).toHaveLength(2);
    expect(overview.warnings[0]).toContain("paused");
    expect(overview.warnings[1]).toContain("denied");
  });

  it("reports an App with no installation as zero installations and no repositories", async () => {
    const overview = await lister(fakeGithub([])).overview();
    expect(overview).toEqual({ installations: 0, repos: [], truncated: false, warnings: [] });
  });

  it("throws a clear error when no App is configured, without calling GitHub", async () => {
    const fake = fakeGithub([]);
    await expect(lister(fake, { now: T0 }, null).overview()).rejects.toThrow(new GithubAppError("The GitHub App is not configured in this dashboard.", 0));
    expect(fake.calls).toHaveLength(0);
  });

  it("says what is wrong when GitHub refuses the credentials or cannot be reached", async () => {
    const refused = { fetch: async () => new Response("{}", { status: 401 }), now: () => T0, credentials: () => CREDENTIALS };
    await expect(new InstalledRepos(refused).overview()).rejects.toThrow(/rejected the App's credentials/);
    const down = { fetch: async () => Promise.reject(new Error("ECONNREFUSED")), now: () => T0, credentials: () => CREDENTIALS };
    await expect(new InstalledRepos(down).overview()).rejects.toThrow(/Could not reach api.github.com/);
  });

  it(`caches the listing for ${REPOS_CACHE_MS / 1000} seconds, shares a read in flight, and reads again after clear()`, async () => {
    const fake = fakeGithub([{ id: 1, repos: [repo("a/b")] }]);
    const clock = { now: T0 };
    const l = lister(fake, clock);
    const [x, y] = await Promise.all([l.overview(), l.overview()]);
    expect(x).toBe(y);
    const after1 = fake.calls.length;
    clock.now = T0 + REPOS_CACHE_MS - 1;
    expect(await l.overview()).toBe(x);
    expect(fake.calls).toHaveLength(after1);
    clock.now = T0 + REPOS_CACHE_MS;
    expect(await l.overview()).not.toBe(x);
    expect(fake.calls.length).toBeGreaterThan(after1);
    const before = fake.calls.length;
    l.clear();
    await l.overview();
    expect(fake.calls.length).toBeGreaterThan(before);
  });

  it("does not serve one App's listing to another App", async () => {
    const fake = fakeGithub([{ id: 1, repos: [repo("a/b")] }]);
    let creds: typeof CREDENTIALS | null = CREDENTIALS;
    const l = new InstalledRepos({ fetch: fake.fetch, now: () => T0, credentials: () => creds });
    const first = await l.overview();
    creds = { ...CREDENTIALS, appId: "9999" };
    expect(await l.overview()).not.toBe(first);
    creds = null;
    await expect(l.overview()).rejects.toBeInstanceOf(GithubAppError);
  });

  it("never stores an installation token: not in the database, not in the cached listing", async () => {
    const fake = fakeGithub([{ id: 1, repos: [repo("a/b")] }]);
    const l = lister(fake);
    const overview = await l.overview();
    expect(JSON.stringify(overview)).not.toContain("ghs_");
    expect(JSON.stringify(l)).not.toContain("ghs_");
    for (const table of ["integrations", "audit_log", "github_app_states", "sessions"]) expect(JSON.stringify(db().prepare(`SELECT * FROM ${table}`).all())).not.toContain("ghs_");
  });
});
