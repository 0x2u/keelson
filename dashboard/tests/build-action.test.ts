import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GithubModule from "@/lib/github";
import type * as GithubAppModule from "@/lib/github-app";
import { GithubAppError } from "@/lib/github-app";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-action-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);

const builds: { link: unknown; run: unknown }[] = [];
const lookups: { token: string; repo: string; branch: string }[] = [];
let result: { ok: true; deploymentId: string } | { ok: false; error: string } = { ok: true, deploymentId: "dep-1" };
let tokenError: GithubAppError | null = null;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/github-webhook", () => ({
  startBuild: async (link: unknown, run: unknown) => {
    builds.push({ link, run });
    return result;
  },
}));
vi.mock("@/lib/github-app", async (original) => ({
  ...(await original<typeof GithubAppModule>()),
  installationToken: async () => {
    if (tokenError) throw tokenError;
    return "installation-token";
  },
}));
vi.mock("@/lib/github", async (original) => ({
  ...(await original<typeof GithubModule>()),
  githubCommits: async (token: string, repo: string, branch: string) => {
    lookups.push({ token, repo, branch });
    return [{ sha: HEAD }];
  },
}));

const { db } = await import("@/lib/db");
const { buildAction } = await import("@/app/github-actions");
const { buildBlock } = await import("@/lib/build-now-core");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let server = "";
beforeAll(() => {
  server = servers.createServer({ name: "prod", url: "https://prod.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["app_repos", "audit_log"]) db().exec(`DELETE FROM ${table}`);
  builds.length = 0;
  lookups.length = 0;
  result = { ok: true, deploymentId: "dep-1" };
  tokenError = null;
  integrations.setAppRepo(server, "shop", { repo: "acme/shop", branch: "release" });
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const events = () => store.recentAudit(50).map((e) => `${e.event}: ${e.detail}`);

describe("buildAction", () => {
  it("builds the head of the linked branch, read with the App's installation token, and audits it", async () => {
    expect(await buildAction(server, "shop", {}, form({}))).toEqual({ deploymentId: "dep-1" });
    expect(lookups).toEqual([{ token: "installation-token", repo: "acme/shop", branch: "release" }]);
    expect(builds).toEqual([{ link: { serverId: server, app: "shop" }, run: { repo: "acme/shop", branch: "release", sha: HEAD } }]);
    expect(events()).toEqual([`build_started: shop <- acme/shop@${HEAD.slice(0, 7)}`]);
  });

  it("builds the commit it is given without asking GitHub for the branch", async () => {
    await buildAction(server, "shop", {}, form({ sha: SHA }));
    expect(lookups).toEqual([]);
    expect(builds[0]).toMatchObject({ run: { sha: SHA } });
  });

  it("refuses an app that is not linked to a repository, and anything that is not a full SHA", async () => {
    integrations.removeAppRepo(server, "shop");
    expect(await buildAction(server, "shop", {}, form({}))).toEqual({ error: expect.stringContaining("Link this app") });
    integrations.setAppRepo(server, "shop", { repo: "acme/shop", branch: "release" });
    expect(await buildAction(server, "shop", {}, form({ sha: "main; rm -rf" }))).toEqual({ error: expect.stringContaining("full commit SHA") });
    expect(builds).toEqual([]);
  });

  it("says why GitHub could not be asked, and starts nothing", async () => {
    tokenError = new GithubAppError("The GitHub App is not installed on acme/shop: install it.", 404);
    expect(await buildAction(server, "shop", {}, form({}))).toEqual({ error: "The GitHub App is not installed on acme/shop: install it." });
    expect(builds).toEqual([]);
  });

  it("returns the agent's refusal and records that it was refused", async () => {
    result = { ok: false, error: "the agent cannot build this app" };
    expect(await buildAction(server, "shop", {}, form({ sha: SHA }))).toEqual({ error: "the agent cannot build this app" });
    expect(events()).toEqual([`build_started: shop <- acme/shop@${SHA.slice(0, 7)} (refused)`]);
  });
});

describe("buildBlock", () => {
  const ok = { canDeploy: true, githubAppConfigured: true, linked: true, deploying: false };

  it("allows a build when nothing stands in the way", () => {
    expect(buildBlock(ok)).toBeNull();
  });

  it("gives the first reason that applies, in the order the operator can fix them", () => {
    expect(buildBlock({ ...ok, canDeploy: false, githubAppConfigured: false })).toContain("read-only");
    expect(buildBlock({ ...ok, githubAppConfigured: false, linked: false })).toContain("GitHub App is not set up");
    expect(buildBlock({ ...ok, linked: false, deploying: true })).toContain("Link this app");
    expect(buildBlock({ ...ok, deploying: true, serving: true })).toContain("deployment is running");
    expect(buildBlock({ ...ok, serving: true })).toContain("already serving");
  });
});
