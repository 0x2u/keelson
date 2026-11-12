import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";
import type { Preview } from "@/lib/agent-types";
import type { WebhookDeps } from "@/lib/github-webhook";
import { GithubError } from "@/lib/github";
import { signBody } from "@/lib/github-webhook-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-previews-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { handleGithubWebhook } = await import("@/lib/github-webhook");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const URL12 = "https://pr-12-shop.example.com";

let secret = "";
let staging = "";
let production = "";

beforeAll(() => {
  staging = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  production = servers.createServer({ name: "production", url: "https://prod.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of ["webhook_deliveries", "app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  secret = integrations.regenerateWebhookSecret();
  integrations.saveGithubConnection("ghp_x", "me");
  // staging: previews on, and automatic deploys too, to show the two never mix.
  integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "main" });
  integrations.setPreviewsWorkflow(staging, "shop", "Build and push");
  integrations.setAutoDeployWorkflow(staging, "shop", "Build and push");
  // production: previews off.
  integrations.setAppRepo(production, "shop", { repo: "Acme/Shop", branch: "main" });
  integrations.setAutoDeployWorkflow(production, "shop", "Build and push");
});

interface FakeAgent {
  /** What GET /v1/previews lists. */
  instances?: Partial<Preview>[];
  previewsError?: AgentError | "hang";
  deployError?: AgentError | "hang";
  deleteError?: AgentError | "hang";
  /** Deployment statuses answered in turn by GET /v1/deployments/{id}. */
  deploymentStatuses?: ("running" | "succeeded" | "failed")[];
  evicted?: string[];
  puts: { app: string; pr: number; sha: string }[];
  deletes: { app: string; pr: number }[];
  deploys: { app: string; tag: string }[];
}

const agentFake = (over: Partial<FakeAgent> = {}): FakeAgent => ({ puts: [], deletes: [], deploys: [], ...over });

interface Harness {
  deps: WebhookDeps;
  statuses: { token: string; repo: string; sha: string; state: string; description: string; targetUrl?: string }[];
  background: Promise<void>[];
  settle(): Promise<void>;
}

function harness(agents: Record<string, FakeAgent>, over: Partial<WebhookDeps> & { statusError?: GithubError } = {}): Harness {
  const statuses: Harness["statuses"] = [];
  const background: Promise<void>[] = [];
  const { statusError, ...rest } = over;
  let clock = 0;
  const deps: WebhookDeps = {
    agent: () => {
      throw new Error("the production agent client is not used by previews");
    },
    compare: async () => ({ aheadBy: 1, behindBy: 0 }),
    pullRequest: async () => ({ open: true, merged: false, headSha: SHA }),
    previewAgent: (server) => {
      const fake = agents[server.id]!;
      return {
        previews: async () => {
          if (fake.previewsError === "hang") return new Promise<never>(() => {});
          if (fake.previewsError) throw fake.previewsError;
          return (fake.instances ?? []).map((i) => ({ app: "shop", ...i })) as Preview[];
        },
        deployPreview: async (app, pr, sha) => {
          if (fake.deployError === "hang") return new Promise<never>(() => {});
          if (fake.deployError) throw fake.deployError;
          fake.puts.push({ app, pr, sha });
          return { deployment_id: `dep-${server.name}-${fake.puts.length}`, name: `${app}-pr-${pr}`, url: `https://pr-${pr}-${app}.example.com`, evicted: fake.evicted ?? [] };
        },
        deletePreview: async (app, pr) => {
          if (fake.deleteError === "hang") return new Promise<never>(() => {});
          if (fake.deleteError) throw fake.deleteError;
          fake.deletes.push({ app, pr });
        },
        deployment: async () => {
          const list = fake.deploymentStatuses ?? ["succeeded"];
          return { status: list.shift() ?? "succeeded", error: undefined } as never;
        },
      };
    },
    postStatus: async (token, repo, sha, status) => {
      if (statusError) throw statusError;
      statuses.push({ token, repo, sha, state: status.state, description: status.description, targetUrl: status.targetUrl });
    },
    background: (task) => void background.push(task()),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    ...rest,
  };
  return { deps, statuses, background, settle: async () => void (await Promise.all(background)) };
}

function runPayload(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "Acme/Shop" },
    workflow_run: {
      id: 200,
      run_attempt: 1,
      name: "Build and push",
      conclusion: "success",
      event: "pull_request",
      head_sha: SHA,
      head_branch: "feature",
      head_repository: { full_name: "Acme/Shop" },
      pull_requests: [{ number: 12, base: { ref: "main" } }],
      ...over,
    },
    ...top,
  };
}

function closedPayload(over: Record<string, unknown> = {}) {
  return { action: "closed", number: 12, repository: { full_name: "Acme/Shop" }, pull_request: { number: 12, merged: false }, ...over };
}

function delivery(body: unknown, opts: { event?: string; id?: string } = {}): Request {
  const raw = JSON.stringify(body);
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event ?? "workflow_run",
      "x-github-delivery": opts.id ?? "delivery-1",
      "x-hub-signature-256": signBody(secret, raw),
    },
    body: raw,
  });
}

type Results = { ignored?: string; results: { server: string; app: string; outcome: string; detail: string; deployment_id?: string }[] };
const send = async (h: Harness, body: unknown, opts?: { event?: string; id?: string }) => (await handleGithubWebhook(delivery(body, opts), h.deps)).json() as Promise<Results>;

describe("a successful pull request run", () => {
  it("creates the preview on the server that has previews on, records it under the preview's name, and leaves the others alone", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const out = await send(h, runPayload());
    expect(out.results).toEqual([{ server: "staging", app: "shop-pr-12", outcome: "deployed", detail: `preview deployment started: ${URL12}`, deployment_id: "dep-staging-1" }]);
    expect(agents[staging].puts).toEqual([{ app: "shop", pr: 12, sha: SHA }]);
    expect(agents[production].puts).toEqual([]);
    expect(agents[staging].deploys).toEqual([]); // never the production deploy
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "deployed", sha: SHA, branch: "feature", deploymentId: "dep-staging-1" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toBeNull();
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("writes one audit line, without the secret", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() });
    await send(h, runPayload());
    const lines = store.recentAudit(50).filter((e) => e.event === "webhook_delivery");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("Acme/Shop@aaaaaaa");
    expect(lines[0].detail).toContain("staging/shop-pr-12 deployed");
    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it("mentions the instances the agent evicted to stay within the template's maximum", async () => {
    const h = harness({ [staging]: agentFake({ evicted: ["shop-pr-3"] }), [production]: agentFake() });
    expect((await send(h, runPayload())).results[0]!.detail).toContain("evicted shop-pr-3");
  });
});

describe("which pull request runs are refused", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["a fork", { head_repository: { full_name: "mallory/shop" }, pull_requests: [] }, "the run comes from a fork"],
    ["another workflow", { name: "Lint" }, "no app has previews for this run"],
    ["a push run", { event: "push" }, "no app deploys automatically from this run"],
    ["pull_request_target", { event: "pull_request_target" }, "pull request runs never deploy"],
    ["a failed run", { conclusion: "failure" }, "the run did not succeed"],
    ["a run with no pull request number", { pull_requests: [] }, "the run belongs to no pull request"],
    ["a pull request into another branch", { pull_requests: [{ number: 12, base: { ref: "release" } }] }, "no app has previews for this run"],
    ["an out-of-range pull request number", { pull_requests: [{ number: 1_000_000, base: { ref: "main" } }] }, "the run belongs to no pull request"],
    ["an abbreviated SHA", { head_sha: "abc1234" }, "the run has no full commit SHA"],
  ];
  for (const [label, over, reason] of cases) {
    it(`does nothing for ${label}`, async () => {
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      const h = harness(agents);
      const out = await send(h, runPayload(over));
      expect(out).toMatchObject({ results: [] });
      if (label !== "a push run") expect(out.ignored).toBe(reason);
      for (const a of Object.values(agents)) expect([a.puts, a.deploys, a.deletes]).toEqual([[], [], []]);
      expect(deliveries.recentDeliveries(staging, "shop")).toEqual([]);
      expect(deliveries.recentPreviewDeliveries(staging, "shop")).toEqual([]);
      expect(h.statuses).toEqual([]);
    });
  }

  it("does nothing while previews are off, even though automatic deploys are on", async () => {
    integrations.setPreviewsWorkflow(staging, "shop", null);
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const out = await send(harness(agents), runPayload());
    expect(out).toMatchObject({ ignored: "no app has previews for this run", results: [] });
    expect(agents[staging].puts).toEqual([]);
    expect(agents[staging].deploys).toEqual([]);
  });

  it("does nothing for the incomplete run of a requested action", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    expect(await send(harness(agents), runPayload({}, { action: "requested" }))).toMatchObject({ ignored: "the run has not completed", results: [] });
  });

  it("refuses a missing delivery id when it would act", async () => {
    const raw = JSON.stringify(runPayload());
    const res = await handleGithubWebhook(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "workflow_run", "x-hub-signature-256": signBody(secret, raw) }, body: raw }),
      harness({ [staging]: agentFake(), [production]: agentFake() }).deps,
    );
    expect(res.status).toBe(400);
  });
});

describe("the production path with a pull request run", () => {
  it("never deploys the app, whatever the previews do, and records nothing for it", async () => {
    integrations.setAutoDeployWorkflow(production, "shop", "Build and push");
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    await send(h, runPayload());
    for (const a of Object.values(agents)) expect(a.deploys).toEqual([]);
    expect(deliveries.recentDeliveries(production, "shop")).toEqual([]);
    expect(deliveries.recentDeliveries(staging, "shop")).toEqual([]);
  });
});

describe("a closed pull request", () => {
  it("removes its preview from every app linked to the repository that has previews on", async () => {
    integrations.setPreviewsWorkflow(production, "shop", "Build and push");
    integrations.setAppRepo(staging, "admin", { repo: "acme/shop", branch: "main" });
    integrations.setPreviewsWorkflow(staging, "admin", "Build and push");
    integrations.setAppRepo(staging, "docs", { repo: "acme/shop", branch: "main" }); // previews off: left alone
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const out = await send(harness(agents), closedPayload(), { event: "pull_request" });
    expect(out.results.map((r) => `${r.server}/${r.app}:${r.outcome}`).sort()).toEqual(["production/shop-pr-12:removed", "staging/admin-pr-12:removed", "staging/shop-pr-12:removed"]);
    expect(agents[staging].deletes.map((d) => `${d.app}#${d.pr}`).sort()).toEqual(["admin#12", "shop#12"]);
    expect(agents[production].deletes).toEqual([{ app: "shop", pr: 12 }]);
  });

  it("removes it whether the pull request was merged or not", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await send(harness(agents), closedPayload({ pull_request: { number: 12, merged: true } }), { event: "pull_request" });
    expect(agents[staging].deletes).toEqual([{ app: "shop", pr: 12 }]);
  });

  it("ignores every other action (opened, reopened and updated ones are for the GitHub App's builds: see github-app-build.test.ts)", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    for (const action of ["edited", "labeled", "ready_for_review"]) {
      const out = await send(harness(agents), closedPayload({ action }), { event: "pull_request", id: `d-${action}` });
      expect(out, action).toMatchObject({ ignored: "only opened, reopened and updated pull requests are built", results: [] });
    }
    for (const action of ["opened", "synchronize", "reopened"]) {
      const out = await send(harness(agents), closedPayload({ action }), { event: "pull_request", id: `d-${action}` });
      expect(out, action).toMatchObject({ ignored: "the pull request did not come through the GitHub App", results: [] });
    }
    expect(agents[staging].deletes).toEqual([]);
    expect(agents[staging].puts).toEqual([]);
  });

  it("does nothing for a repository without previews, an out-of-range number, and answers 400 to a malformed payload", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    expect(await send(harness(agents), closedPayload({ repository: { full_name: "acme/other" } }), { event: "pull_request" })).toMatchObject({ results: [] });
    expect(await send(harness(agents), closedPayload({ pull_request: { number: 0 } }), { event: "pull_request" })).toMatchObject({ results: [] });
    expect(agents[staging].deletes).toEqual([]);
    const bad = await handleGithubWebhook(delivery({ action: "closed" }, { event: "pull_request" }), harness(agents).deps);
    expect(bad.status).toBe(400);
  });

  it("reports an agent that refuses, cannot be reached, is too old or does not answer, per server, without stopping the others", async () => {
    integrations.setPreviewsWorkflow(production, "shop", "Build and push");
    const agents = { [staging]: agentFake({ deleteError: new AgentError(409, "busy") }), [production]: agentFake() };
    const refused = await send(harness(agents), closedPayload(), { event: "pull_request" });
    expect(refused.results.find((r) => r.server === "staging")).toMatchObject({ outcome: "failed", detail: "a deployment is already running" });
    expect(refused.results.find((r) => r.server === "production")?.outcome).toBe("removed");

    const old = await send(harness({ [staging]: agentFake({ deleteError: new AgentError(404, "not found") }), [production]: agentFake() }), closedPayload(), { event: "pull_request" });
    expect(old.results.find((r) => r.server === "staging")).toMatchObject({ outcome: "skipped" });

    const slow = harness({ [staging]: agentFake({ deleteError: "hang" }), [production]: agentFake() }, { deployBudgetMs: 30 });
    const started = Date.now();
    const unanswered = await send(slow, closedPayload(), { event: "pull_request" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(unanswered.results.find((r) => r.server === "staging")).toMatchObject({ outcome: "unknown", detail: expect.stringContaining("may have been removed") });
    expect(unanswered.results.find((r) => r.server === "production")?.outcome).toBe("removed");
  });

  it("needs no delivery id (the removal is idempotent), and writes an audit line", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const raw = JSON.stringify(closedPayload());
    const res = await handleGithubWebhook(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": signBody(secret, raw) }, body: raw }),
      harness(agents).deps,
    );
    expect(res.status).toBe(200);
    expect(agents[staging].deletes).toHaveLength(1);
    expect(store.recentAudit(50).find((e) => e.event === "webhook_delivery")?.detail).toContain("Acme/Shop#12 closed: staging/shop-pr-12 removed");
  });
});

describe("claims and redelivery under the preview's name", () => {
  it("does not deploy again what a delivery already deployed, nor the same run under another delivery id", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    await send(h, runPayload());
    const again = await send(h, runPayload());
    const otherId = await send(h, runPayload(), { id: "second-id" });
    expect(agents[staging].puts).toHaveLength(1);
    expect(again.results[0]).toMatchObject({ outcome: "deployed", deployment_id: "dep-staging-1" });
    expect(otherId.results[0]).toMatchObject({ outcome: "deployed" });
  });

  it("treats another run or another attempt as a new event", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    let current = SHA;
    const h = harness(agents, { pullRequest: async () => ({ open: true, merged: false, headSha: current }) });
    await send(h, runPayload(), { id: "a" });
    current = OLD;
    await send(h, runPayload({ run_attempt: 2, head_sha: OLD }), { id: "b" });
    current = "c".repeat(40);
    await send(h, runPayload({ id: 201, head_sha: "c".repeat(40) }), { id: "c" });
    expect(agents[staging].puts.map((p) => p.sha)).toEqual([SHA, OLD, "c".repeat(40)]);
  });

  it("deploys once when two identical deliveries arrive together", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const slowDeps: WebhookDeps = { ...h.deps, previewAgent: (server) => ({ ...h.deps.previewAgent!(server), deployPreview: async (app, pr, sha) => (await new Promise((r) => setTimeout(r, 25)), h.deps.previewAgent!(server).deployPreview(app, pr, sha)) }) };
    const [a, b] = await Promise.all([
      handleGithubWebhook(delivery(runPayload()), slowDeps).then((r) => r.json() as Promise<Results>),
      handleGithubWebhook(delivery(runPayload()), slowDeps).then((r) => r.json() as Promise<Results>),
    ]);
    expect(agents[staging].puts).toHaveLength(1);
    expect([a.results[0]!.outcome, b.results[0]!.outcome].sort()).toEqual(["deployed", "pending"]);
  });

  it("keeps a preview's rows apart from a production deploy of the same commit and delivery", async () => {
    // The same delivery id and commit deploy the app itself (a push run) and the preview (a pull request run): neither blocks nor replaces the other.
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    deliveries.claimDelivery({ deliveryId: "delivery-1", repo: "Acme/Shop", branch: "main", sha: SHA, serverId: staging, app: "shop", runKey: "acme/shop#200#1" });
    const out = await send(h, runPayload());
    expect(out.results[0]).toMatchObject({ app: "shop-pr-12", outcome: "deployed" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "pending" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "deployed" });

    deliveries.recordDelivery({ deliveryId: "delivery-1", repo: "Acme/Shop", branch: "main", sha: SHA, serverId: staging, app: "shop", outcome: "deployed", detail: "deployment started", deploymentId: "prod-1", runKey: "acme/shop#200#1" });
    expect(deliveries.recentPreviewDeliveries(staging, "shop").map((r) => r.app)).toEqual(["shop-pr-12"]);
    expect(deliveries.recentDeliveries(staging, "shop").map((r) => r.deploymentId)).toEqual(["prod-1"]);
  });

  it("evaluates a failed delivery again and replaces its row", async () => {
    const failing = { [staging]: agentFake({ deployError: new AgentError(409, "busy") }), [production]: agentFake() };
    await send(harness(failing), runPayload());
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "failed", detail: "a deployment is already running" });
    const healthy = { [staging]: agentFake(), [production]: agentFake() };
    await send(harness(healthy), runPayload());
    expect(healthy[staging].puts).toHaveLength(1);
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "deployed" });
  });

  it("does not let a fresh claim be taken, but takes a stale one over", async () => {
    deliveries.claimDelivery({ deliveryId: "delivery-1", repo: "Acme/Shop", branch: "feature", sha: SHA, serverId: staging, app: "shop-pr-12", runKey: "acme/shop#200#1" });
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    expect((await send(harness(agents), runPayload())).results[0]).toMatchObject({ outcome: "pending" });
    expect(agents[staging].puts).toEqual([]);
    db().prepare("UPDATE webhook_deliveries SET at = ?").run(Date.now() - deliveries.PENDING_STALE_MS - 1000);
    await send(harness(agents), runPayload());
    expect(agents[staging].puts).toHaveLength(1);
  });

  it("records a deploy request that got no answer as unknown, and does not repeat it while the previews cannot be read", async () => {
    const hang = { [staging]: agentFake({ deployError: "hang" }), [production]: agentFake() };
    const first = await send(harness(hang, { deployBudgetMs: 30 }), runPayload());
    expect(first.results[0]).toMatchObject({ outcome: "unknown", detail: expect.stringContaining("may have started") });
    const down = { [staging]: agentFake({ previewsError: new AgentError(0, "cannot reach the agent") }), [production]: agentFake() };
    const again = await send(harness(down), runPayload({ id: 300 }), { id: "other" });
    expect(again.results[0]).toMatchObject({ outcome: "unknown" });
    expect(down[staging].puts).toEqual([]);
  });
});

describe("what a preview is deployed over", () => {
  const instance = (over: Partial<Preview> = {}) => ({ name: "shop-pr-12", pr: 12, ref: `ghcr.io/acme/shop:${OLD}`, status: "running" as const, ...over });

  it("redeploys a newer commit over the serving one", async () => {
    const agents = { [staging]: agentFake({ instances: [instance()] }), [production]: agentFake() };
    const compare = vi.fn<WebhookDeps["compare"]>(async () => ({ aheadBy: 1, behindBy: 0 }));
    const out = await send(harness(agents, { compare }), runPayload());
    expect(out.results[0]!.outcome).toBe("deployed");
    expect(compare).toHaveBeenCalledWith("ghp_x", "Acme/Shop", OLD, SHA);
  });

  it("skips the commit that serves, and a run GitHub proves older than what serves", async () => {
    const serving = { [staging]: agentFake({ instances: [instance({ ref: `x:${SHA}` })] }), [production]: agentFake() };
    expect((await send(harness(serving), runPayload())).results[0]).toMatchObject({ outcome: "skipped", detail: "already serving" });
    const older = { [staging]: agentFake({ instances: [instance()] }), [production]: agentFake() };
    const out = await send(harness(older, { compare: async () => ({ aheadBy: 0, behindBy: 2 }) }), runPayload(), { id: "d2" });
    expect(out.results[0]).toMatchObject({ outcome: "skipped", detail: "older than what is serving" });
    expect(serving[staging].puts).toEqual([]);
    expect(older[staging].puts).toEqual([]);
  });

  it("deploys after a force push (diverged), when GitHub cannot compare, and without a token", async () => {
    for (const [i, h] of [
      [1, (a: Record<string, FakeAgent>) => harness(a, { compare: async () => ({ aheadBy: 2, behindBy: 1 }) })],
      [2, (a: Record<string, FakeAgent>) => harness(a, { compare: async () => Promise.reject(new Error("rate limited")) })],
      [3, (a: Record<string, FakeAgent>) => (integrations.removeGithubConnection(), harness(a))],
    ] as const) {
      db().exec("DELETE FROM webhook_deliveries");
      const agents = { [staging]: agentFake({ instances: [instance()] }), [production]: agentFake() };
      const out = await send(h(agents), runPayload(), { id: `d${i}` });
      expect(out.results[0]!.outcome, String(i)).toBe("deployed");
      expect(agents[staging].puts).toHaveLength(1);
    }
  });

  it("tries the same commit again when the preview's last deployment failed", async () => {
    const agents = { [staging]: agentFake({ instances: [instance({ ref: `x:${SHA}`, status: "failed" })] }), [production]: agentFake() };
    expect((await send(harness(agents), runPayload())).results[0]!.outcome).toBe("deployed");
  });

  it("gives the comparison a budget of its own", async () => {
    const agents = { [staging]: agentFake({ instances: [instance()] }), [production]: agentFake() };
    const h = harness(agents, { compare: () => new Promise(() => {}), compareBudgetMs: 30 });
    const started = Date.now();
    expect((await send(h, runPayload())).results[0]!.outcome).toBe("deployed");
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("errors from the agent", () => {
  const failed = async (agent: Partial<FakeAgent>, extra: Partial<WebhookDeps> = {}) =>
    (await send(harness({ [staging]: agentFake(agent), [production]: agentFake() }, extra), runPayload())).results[0]!;

  it("says why in words an operator can act on", async () => {
    expect(await failed({ deployError: new AgentError(409, "busy") })).toMatchObject({ outcome: "failed", detail: "a deployment is already running" });
    expect(await failed({ deployError: new AgentError(404, "no template") })).toMatchObject({ outcome: "failed", detail: expect.stringContaining("no preview template") });
    expect(await failed({ deployError: new AgentError(503, "shutting down") })).toMatchObject({ outcome: "failed", detail: "the agent is shutting down" });
    expect(await failed({ deployError: new AgentError(401, "no") })).toMatchObject({ detail: expect.stringContaining("deploy secret") });
    expect(await failed({ previewsError: new AgentError(0, "cannot reach the agent: connection refused") })).toMatchObject({ outcome: "failed", detail: "cannot reach the agent: connection refused" });
    expect(await failed({ previewsError: "hang" }, { budgetMs: 30 })).toMatchObject({ outcome: "failed", detail: "the agent did not answer in time" });
  });

  it("fails an agent too old for previews, and a server that cannot deploy", async () => {
    const base = harness({ [staging]: agentFake(), [production]: agentFake() });
    const old = { ...base.deps, previewAgent: () => ({ ...base.deps.previewAgent!(staging as never), previews: async () => null }) };
    expect((await handleGithubWebhook(delivery(runPayload()), old).then((r) => r.json() as Promise<Results>)).results[0]).toMatchObject({ outcome: "failed", detail: "previews are not available on this server" });
    db().prepare("UPDATE servers SET deploy_secret_enc = NULL WHERE id = ?").run(staging);
    expect((await send(base, runPayload(), { id: "d2" })).results[0]).toMatchObject({ outcome: "failed", detail: "this server has no deploy secret in the dashboard" });
    db().prepare("UPDATE servers SET deploy_secret_enc = (SELECT deploy_secret_enc FROM servers WHERE id = ?) WHERE id = ?").run(production, staging);
  });
});

describe("the commit status", () => {
  it("posts pending after the answer is ready, then success linking the preview once the deployment succeeded", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["running", "running", "succeeded"] }), [production]: agentFake() };
    const h = harness(agents);
    const out = await send(h, runPayload());
    expect(out.results[0]!.outcome).toBe("deployed");
    expect(h.background).toHaveLength(1);
    await h.settle();
    expect(h.statuses).toEqual([
      { token: "ghp_x", repo: "Acme/Shop", sha: SHA, state: "pending", description: "Preview deploying", targetUrl: undefined },
      { token: "ghp_x", repo: "Acme/Shop", sha: SHA, state: "success", description: "Preview deployed", targetUrl: URL12 },
    ]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")?.detail).toBe(`preview deployment started: ${URL12}`);
  });

  it("does not hold the answer for GitHub or the deployment: nothing is posted until the background task runs", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const queued: (() => Promise<void>)[] = [];
    const h = harness(agents, { background: (task) => void queued.push(task) });
    await send(h, runPayload());
    expect(h.statuses).toEqual([]);
    expect(queued).toHaveLength(1);
    await queued[0]!();
    expect(h.statuses.map((s) => s.state)).toEqual(["pending", "success"]);
  });

  it("posts failure with the reason when the deployment fails", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["running", "failed"] }), [production]: agentFake() };
    const h = harness(agents);
    await send(h, runPayload());
    await h.settle();
    expect(h.statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
    expect(h.statuses[1]!.targetUrl).toBeUndefined();
  });

  it("posts failure when the deployment is still running at the timeout, on the injected clock", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: Array(1000).fill("running") }), [production]: agentFake() };
    const slept: number[] = [];
    const h = harness(agents, { pollIntervalMs: 1000, pollTimeoutMs: 4000, sleep: async (ms) => void slept.push(ms) });
    let clock = 0;
    h.deps.now = () => clock;
    h.deps.sleep = async (ms) => {
      slept.push(ms);
      clock += ms;
    };
    await send(h, runPayload());
    await h.settle();
    expect(slept).toEqual([1000, 1000, 1000, 1000]);
    expect(h.statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
    expect(h.statuses[1]!.description).toContain("did not finish");
  });

  it("skips silently without a token, saying so in the delivery's detail", async () => {
    integrations.removeGithubConnection();
    const h = harness({ [staging]: agentFake(), [production]: agentFake() });
    const out = await send(h, runPayload());
    expect(out.results[0]).toMatchObject({ outcome: "deployed", detail: expect.stringContaining("status not reported: no GitHub token is connected") });
    expect(h.background).toHaveLength(0);
    expect(h.statuses).toEqual([]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")?.detail).toContain("status not reported: no GitHub token");
  });

  it("skips when GitHub answers 403 or 404, after the deployment was accepted, and notes it in the delivery's detail", async () => {
    for (const status of [403, 404]) {
      db().exec("DELETE FROM webhook_deliveries");
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      const h = harness(agents, { statusError: new GithubError(`The token cannot write commit statuses (${status})`, status) });
      const out = await send(h, runPayload());
      expect(out.results[0]!.outcome).toBe("deployed"); // the preview is deployed whatever GitHub says
      await h.settle();
      expect(agents[staging].puts).toHaveLength(1);
      expect(h.statuses).toEqual([]);
      expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")?.detail).toBe(`preview deployment started: ${URL12} (status not reported: The token cannot write commit statuses (${status}))`);
    }
  });

  it("survives a background scheduler that throws, and posts nothing for a redelivery of what deployed", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents, {
      background: () => {
        throw new Error("outside a request");
      },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send(h, runPayload())).results[0]!.outcome).toBe("deployed");
    quiet.mockRestore();
    const h2 = harness(agents);
    await send(h2, runPayload());
    await h2.settle();
    expect(h2.statuses).toEqual([]);
    expect(agents[staging].puts).toHaveLength(1);
  });
});

describe("storage of the previews switch", () => {
  it("stores the workflow, lists the links for a repository in any case, and turns it off with null", () => {
    expect(integrations.getAppRepo(staging, "shop")?.previewsWorkflow).toBe("Build and push");
    expect(integrations.previewLinks("ACME/shop").map((l) => `${l.serverId}/${l.app}`)).toEqual([`${staging}/shop`]);
    expect(integrations.previewLinks("acme/other")).toEqual([]);
    expect(integrations.setPreviewsWorkflow(staging, "shop", null)).toBe(true);
    expect(integrations.getAppRepo(staging, "shop")).toMatchObject({ previewsWorkflow: null, autoDeployWorkflow: "Build and push" });
    expect(integrations.previewLinks("acme/shop")).toEqual([]);
    expect(integrations.setPreviewsWorkflow(staging, "unlinked", "x")).toBe(false);
  });

  it("keeps previews when the same link is saved again, and resets them (but not the other apps') when the source changes", () => {
    integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "main" });
    expect(integrations.getAppRepo(staging, "shop")?.previewsWorkflow).toBe("Build and push");
    integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "release" });
    expect(integrations.getAppRepo(staging, "shop")).toMatchObject({ previewsWorkflow: null, autoDeployWorkflow: null });
    integrations.setPreviewsWorkflow(staging, "shop", "Build and push");
    integrations.setAppRepo(staging, "shop", { repo: "acme/other", branch: "release" });
    expect(integrations.getAppRepo(staging, "shop")?.previewsWorkflow).toBeNull();
  });
});

describe("the schema upgrade", () => {
  it("adds the previews and build columns to a database at the version before previews, keeping the links and their automatic deploys", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase, SCHEMA_VERSION } = await import("@/lib/db");
    const file = path.join(dir, "before-previews.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      CREATE TABLE app_repos (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, app TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
        auto_deploy_workflow TEXT, PRIMARY KEY (server_id, app)
      );
      INSERT INTO servers (id) VALUES ('s');
      INSERT INTO app_repos (server_id, app, repo, branch, auto_deploy_workflow) VALUES ('s', 'shop', 'a/b', 'main', 'Build');
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY); -- a later migration adds the step-up column to it
      PRAGMA user_version = 6;
    `);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("SELECT app, repo, auto_deploy_workflow, previews_workflow FROM app_repos").all()).toEqual([
        { app: "shop", repo: "a/b", auto_deploy_workflow: "Build", previews_workflow: null },
      ]);
      expect((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      upgraded.exec("UPDATE app_repos SET previews_workflow = 'Build'");
      expect(upgraded.prepare("SELECT previews_workflow FROM app_repos").get()).toEqual({ previews_workflow: "Build" });
    } finally {
      upgraded.close();
    }
  });
});

describe("the pull request's state when its run finishes", () => {
  const setup = (over: Partial<WebhookDeps> = {}) => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    return { agents, h: harness(agents, over) };
  };

  it("skips a run whose pull request was closed meanwhile", async () => {
    const { agents, h } = setup({ pullRequest: async () => ({ open: false, merged: true, headSha: SHA }) });
    const out = await send(h, runPayload());
    expect(out.results).toMatchObject([{ app: "shop-pr-12", outcome: "skipped", detail: "pull request is closed" }]);
    expect(agents[staging].puts).toEqual([]);
    expect(h.statuses).toEqual([]);
  });

  it("skips a run for a commit the pull request has moved past", async () => {
    const { agents, h } = setup({ pullRequest: async () => ({ open: true, merged: false, headSha: OLD }) });
    const out = await send(h, runPayload());
    expect(out.results).toMatchObject([{ outcome: "skipped", detail: expect.stringContaining("newer push") }]);
    expect(agents[staging].puts).toEqual([]);
  });

  it("deploys for an open pull request at the run's commit, asking GitHub with the token and the number", async () => {
    const asked: unknown[][] = [];
    const { agents, h } = setup({
      pullRequest: async (...args) => {
        asked.push(args);
        return { open: true, merged: false, headSha: SHA };
      },
    });
    const out = await send(h, runPayload());
    expect(out.results[0]).toMatchObject({ outcome: "deployed", detail: `preview deployment started: ${URL12}` });
    expect(asked).toEqual([["ghp_x", "Acme/Shop", 12]]);
    expect(agents[staging].puts).toHaveLength(1);
  });

  it("proceeds, and says so, with no token", async () => {
    integrations.removeGithubConnection();
    const { agents, h } = setup();
    const out = await send(h, runPayload());
    expect(out.results[0]).toMatchObject({ outcome: "deployed", detail: expect.stringContaining("no GitHub token is connected") });
    expect(out.results[0]!.detail).toContain("pull request state not checked");
    expect(agents[staging].puts).toHaveLength(1);
  });

  it("proceeds, and says so, when GitHub is slow or fails", async () => {
    for (const [pullRequest, note] of [
      [() => new Promise<never>(() => {}), "did not answer in time"],
      [async () => { throw new GithubError("GitHub answered with status 502.", 502); }, "status 502"],
      [async () => null, "not what was expected"],
    ] as const) {
      for (const table of ["webhook_deliveries"]) db().exec(`DELETE FROM ${table}`);
      const { agents, h } = setup({ pullRequest, pullRequestBudgetMs: 20 });
      const out = await send(h, runPayload());
      expect(out.results[0]).toMatchObject({ outcome: "deployed", detail: expect.stringContaining(note) });
      expect(out.results[0]!.detail).toContain("pull request state not checked");
      expect(agents[staging].puts).toHaveLength(1);
    }
  });
});
