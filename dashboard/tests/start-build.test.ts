import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";
import type { BuildSource } from "@/lib/agent-types";
import { GithubAppError } from "@/lib/github-app";
import type { WebhookDeps } from "@/lib/github-webhook";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-start-build-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { startBuild } = await import("@/lib/github-webhook");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");

const SHA = "a".repeat(40);
const TOKEN = "ghs_installation_token_1234";

let staging = "";
let readOnly = "";
beforeAll(() => {
  staging = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnly = servers.createServer({ name: "ro", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["webhook_deliveries", "app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: "unused" });
});

function harness(over: { buildError?: AgentError | "hang"; statuses?: ("running" | "succeeded" | "failed")[]; token?: () => Promise<string> } = {}) {
  const builds: { app: string; sha: string; source: BuildSource }[] = [];
  const posted: { token: string; repo: string; sha: string; state: string; targetUrl?: string }[] = [];
  const background: Promise<void>[] = [];
  let clock = 0;
  const deps: WebhookDeps = {
    agent: () => {
      throw new Error("not used");
    },
    compare: async () => null,
    installationToken: over.token ?? (async () => TOKEN),
    buildAgent: () =>
      ({
        build: async (app: string, sha: string, source: BuildSource) => {
          if (over.buildError === "hang") return new Promise<never>(() => {});
          if (over.buildError) throw over.buildError;
          builds.push({ app, sha, source });
          return "dep-1";
        },
        deployment: async () => ({ status: (over.statuses ?? ["succeeded"]).shift() ?? "succeeded" }) as never,
      }) as never,
    postBuildStatus: async (token, repo, sha, status) => void posted.push({ token, repo, sha, state: status.state, targetUrl: status.targetUrl }),
    publicUrl: () => new URL("https://keelson.example.com"),
    background: (task) => void background.push(task()),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    deployBudgetMs: 50,
  };
  return { deps, builds, posted, settle: () => Promise.all(background) };
}

const link = () => ({ serverId: staging, app: "shop" });
const run = { repo: "Acme/Shop", branch: "main", sha: SHA };

describe("startBuild", () => {
  it("asks the agent to build the commit from its tarball with the installation token, and reports the deployment", async () => {
    const h = harness();
    expect(await startBuild(link(), run, h.deps)).toEqual({ ok: true, deploymentId: "dep-1", serverId: staging });
    expect(h.builds).toEqual([{ app: "shop", sha: SHA, source: { url: `https://api.github.com/repos/Acme/Shop/tarball/${SHA}`, token: TOKEN } }]);
  });

  it("records the build under the app like a push, so a push of the same commit does not build it twice", async () => {
    const h = harness();
    await startBuild(link(), run, h.deps);
    const rows = deliveries.recentBuildDeliveries(staging, "shop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: "shop", repo: "Acme/Shop", branch: "main", sha: SHA, outcome: "deployed", deploymentId: "dep-1", runKey: `acme/shop#push#${SHA}` });
    expect(rows[0]!.deliveryId).toMatch(/^dashboard-build:/);
    const claim = deliveries.claimDelivery({ deliveryId: "gh-1", repo: "acme/shop", branch: "main", sha: SHA, serverId: staging, app: "shop", runKey: `acme/shop#push#${SHA}` });
    expect(claim.claimed).toBe(false);
  });

  it("posts the keelson/build status as the webhook flow does, linking the deployment page, with the installation token", async () => {
    const h = harness();
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.posted.map((p) => p.state)).toEqual(["pending", "success"]);
    expect(h.posted.every((p) => p.token === TOKEN && p.repo === "Acme/Shop" && p.sha === SHA)).toBe(true);
    expect(h.posted[0]!.targetUrl).toBe(`https://keelson.example.com/servers/${staging}/deployments/dep-1`);
  });

  it("frees the commit and says so when the build later fails", async () => {
    const h = harness({ statuses: ["failed"] });
    await startBuild(link(), run, h.deps);
    await h.settle();
    expect(h.posted.at(-1)!.state).toBe("failure");
    expect(deliveries.recentBuildDeliveries(staging, "shop")[0]).toMatchObject({ outcome: "failed" });
  });

  it("returns the agent's refusal, records a failure, and keeps the token out of both", async () => {
    const h = harness({ buildError: new AgentError(400, `the app has no build block (${TOKEN})`, null) });
    const out = await startBuild(link(), run, h.deps);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ error: expect.stringContaining("cannot build this app") });
    expect(JSON.stringify([out, deliveries.recentDeliveries(staging, "shop")])).not.toContain(TOKEN);
    expect(deliveries.recentDeliveries(staging, "shop")[0]).toMatchObject({ outcome: "failed" });
  });

  it("can be retried after a failure: the failed row does not hold the commit", async () => {
    expect((await startBuild(link(), run, harness({ buildError: new AgentError(409, "busy", null) }).deps)).ok).toBe(false);
    const h = harness();
    expect(await startBuild(link(), run, h.deps)).toEqual({ ok: true, deploymentId: "dep-1", serverId: staging });
  });

  it("returns the running deployment when the same commit was already started", async () => {
    await startBuild(link(), run, harness().deps);
    const again = harness();
    expect(await startBuild(link(), run, again.deps)).toEqual({ ok: true, deploymentId: "dep-1", serverId: staging });
    expect(again.builds).toEqual([]);
  });

  it("builds the commit again when it is asked for again later: a click an hour on, or after changing where it builds, wants a build", async () => {
    vi.useFakeTimers();
    try {
      await startBuild(link(), run, harness().deps);
      vi.advanceTimersByTime(3 * 60_000);
      const again = harness();
      expect(await startBuild(link(), run, again.deps)).toMatchObject({ ok: true });
      expect(again.builds).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an unanswered request as unknown and says the build may have started", async () => {
    const out = await startBuild(link(), run, harness({ buildError: "hang" }).deps);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("may have started") });
    expect(deliveries.recentDeliveries(staging, "shop")[0]).toMatchObject({ outcome: "unknown" });
  });

  it("explains an App that is not installed on the repository", async () => {
    const out = await startBuild(link(), run, harness({ token: async () => Promise.reject(new GithubAppError("The GitHub App is not installed on Acme/Shop: install it.", 404)) }).deps);
    expect(out).toEqual({ ok: false, error: "The GitHub App is not installed on Acme/Shop: install it." });
  });

  it("refuses without the App, without a deploy secret, for an unknown server and for a bad commit", async () => {
    integrations.removeGithubApp();
    expect(await startBuild(link(), run, harness().deps)).toMatchObject({ ok: false, error: expect.stringContaining("not configured") });
    integrations.saveGithubApp({ appId: "4242", slug: null, privateKey: "unused" });
    expect(await startBuild({ serverId: readOnly, app: "shop" }, run, harness().deps)).toMatchObject({ ok: false, error: expect.stringContaining("no deploy secret") });
    expect(await startBuild({ serverId: "missing", app: "shop" }, run, harness().deps)).toMatchObject({ ok: false, error: expect.stringContaining("not registered") });
    expect(await startBuild(link(), { ...run, sha: "abc" }, harness().deps)).toMatchObject({ ok: false, error: expect.stringContaining("GitHub can serve") });
  });
});
