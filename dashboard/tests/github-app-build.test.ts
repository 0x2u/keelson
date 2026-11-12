import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";
import type { AppStatus, BuildSource, Preview } from "@/lib/agent-types";
import { GithubAppError } from "@/lib/github-app";
import type { WebhookDeps } from "@/lib/github-webhook";
import { signBody } from "@/lib/github-webhook-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-build-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { handleGithubWebhook } = await import("@/lib/github-webhook");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const OTHER = "c".repeat(40);
const INSTALLATION_TOKEN = "ghs_installation_token_1234";
const TARBALL = `https://api.github.com/repos/Acme/Shop/tarball/${SHA}`;
const PUBLIC = new URL("https://keelson.example.com/anything");

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
  integrations.saveGithubConnection("ghp_read_only_pat", "me");
  integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: "unused-by-these-tests" });
  // staging builds pushes and pull requests; production only pushes, and also deploys from CI.
  integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "main" });
  integrations.setBuildModes(staging, "shop", { onPush: true, previews: true });
  integrations.setAppRepo(production, "shop", { repo: "Acme/Shop", branch: "main" });
  integrations.setBuildModes(production, "shop", { onPush: true, previews: false });
});

interface FakeAgent {
  serving?: string | null;
  apps?: "disabled" | "hang" | AgentError;
  instances?: Partial<Preview>[];
  previews?: "disabled" | AgentError;
  buildError?: AgentError | "hang";
  deploymentStatuses?: ("running" | "succeeded" | "failed")[];
  deploymentError?: string;
  builds: { app: string; sha: string; source: BuildSource }[];
  previewBuilds: { app: string; pr: number; sha: string; source: BuildSource }[];
  deploys: { app: string; tag: string }[];
}

const agentFake = (over: Partial<FakeAgent> = {}): FakeAgent => ({ builds: [], previewBuilds: [], deploys: [], serving: null, ...over });

interface Harness {
  deps: WebhookDeps;
  statuses: { kind: "build" | "preview"; token: string; repo: string; sha: string; state: string; description: string; targetUrl?: string }[];
  compares: { token: string; base: string; head: string }[];
  pullChecks: { token: string; n: number }[];
  minted: string[];
  background: Promise<void>[];
  settle(): Promise<void>;
}

function harness(agents: Record<string, FakeAgent>, over: Partial<WebhookDeps> & { statusError?: Error; failSecondToken?: boolean } = {}): Harness {
  const statuses: Harness["statuses"] = [];
  const compares: Harness["compares"] = [];
  const pullChecks: Harness["pullChecks"] = [];
  const minted: string[] = [];
  const background: Promise<void>[] = [];
  const { statusError, failSecondToken, ...rest } = over;
  let clock = 0;
  const post = (kind: "build" | "preview") => async (token: string, repo: string, sha: string, status: { state: string; description: string; targetUrl?: string }) => {
    if (statusError) throw statusError;
    statuses.push({ kind, token, repo, sha, state: status.state, description: status.description, targetUrl: status.targetUrl });
  };
  const deps: WebhookDeps = {
    agent: () => {
      throw new Error("the deploy client is not used by builds");
    },
    compare: async (token, _repo, base, head) => {
      compares.push({ token, base, head });
      return { aheadBy: 1, behindBy: 0 };
    },
    pullRequest: async (token, _repo, n) => {
      pullChecks.push({ token, n });
      return { open: true, merged: false, headSha: SHA };
    },
    installationToken: async () => {
      minted.push("x");
      if (failSecondToken && minted.length > 1) throw new GithubAppError("The GitHub App is not installed on acme/shop: install it.", 404);
      return INSTALLATION_TOKEN;
    },
    buildAgent: (server) => {
      const fake = agents[server.id]!;
      return {
        config: async () => null,
        system: async () => null,
        apps: async () => {
          if (fake.apps === "hang") return new Promise<never>(() => {});
          if (fake.apps === "disabled") return null;
          if (fake.apps) throw fake.apps;
          return [{ name: "shop", container: fake.serving ? { image: fake.serving } : null } as unknown as AppStatus];
        },
        previews: async () => {
          if (fake.previews === "disabled") return null;
          if (fake.previews) throw fake.previews;
          return (fake.instances ?? []).map((i) => ({ app: "shop", ...i })) as Preview[];
        },
        build: async (app, sha, source) => {
          if (fake.buildError === "hang") return new Promise<never>(() => {});
          if (fake.buildError) throw fake.buildError;
          fake.builds.push({ app, sha, source });
          return `build-${server.name}-${fake.builds.length}`;
        },
        buildPreview: async (app, pr, sha, source) => {
          if (fake.buildError === "hang") return new Promise<never>(() => {});
          if (fake.buildError) throw fake.buildError;
          fake.previewBuilds.push({ app, pr, sha, source });
          return { deployment_id: `pbuild-${server.name}-${fake.previewBuilds.length}`, name: `${app}-pr-${pr}`, url: `https://pr-${pr}-${app}.example.com`, evicted: [] };
        },
        deployment: async () => {
          const list = fake.deploymentStatuses ?? ["succeeded"];
          return { status: list.shift() ?? "succeeded", error: fake.deploymentError } as never;
        },
      };
    },
    postStatus: post("preview"),
    postBuildStatus: post("build"),
    publicUrl: () => PUBLIC,
    background: (task) => void background.push(task()),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    ...rest,
  };
  return { deps, statuses, compares, pullChecks, minted, background, settle: async () => void (await Promise.all(background)) };
}

function pushPayload(over: Record<string, unknown> = {}) {
  return { ref: "refs/heads/main", before: OLD, after: SHA, deleted: false, repository: { full_name: "Acme/Shop" }, installation: { id: 9 }, ...over };
}

function pullPayload(action = "opened", over: { pull?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return {
    action,
    number: 12,
    repository: { full_name: "Acme/Shop" },
    installation: { id: 9 },
    pull_request: {
      number: 12,
      head: { sha: SHA, ref: "feature", repo: { full_name: "Acme/Shop" } },
      base: { ref: "main", repo: { full_name: "Acme/Shop" } },
      ...over.pull,
    },
    ...over.top,
  };
}

function runPayload(over: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "Acme/Shop" },
    workflow_run: {
      id: 200,
      run_attempt: 1,
      name: "Build and push",
      conclusion: "success",
      event: "push",
      head_sha: SHA,
      head_branch: "main",
      head_repository: { full_name: "Acme/Shop" },
      pull_requests: [],
      ...over,
    },
  };
}

function delivery(body: unknown, opts: { event: string; id?: string }): Request {
  const raw = JSON.stringify(body);
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event,
      "x-github-delivery": opts.id ?? "delivery-1",
      "x-hub-signature-256": signBody(secret, raw),
    },
    body: raw,
  });
}

type Results = { ignored?: string; error?: string; results: { server: string; app: string; outcome: string; detail: string; deployment_id?: string }[] };
const send = async (h: Harness, body: unknown, event: string, id?: string) => (await handleGithubWebhook(delivery(body, { event, id }), h.deps)).json() as Promise<Results>;
const push = (h: Harness, over?: Record<string, unknown>, id?: string) => send(h, pushPayload(over), "push", id);
const pull = (h: Harness, action?: string, over?: Parameters<typeof pullPayload>[1], id?: string) => send(h, pullPayload(action, over), "pull_request", id);

const everything = (agents: Record<string, FakeAgent>) => Object.values(agents).flatMap((a) => [a.builds, a.previewBuilds, a.deploys]);

describe("a push to the linked branch", () => {
  it("builds the commit on every server that builds pushes, from the tarball, with the installation token, and records it", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const out = await push(h);
    expect(out.results).toEqual([
      { server: "staging", app: "shop", outcome: "deployed", detail: "build and deployment started", deployment_id: "build-staging-1" },
      { server: "production", app: "shop", outcome: "deployed", detail: "build and deployment started", deployment_id: "build-production-1" },
    ]);
    for (const id of [staging, production]) {
      expect(agents[id].builds).toEqual([{ app: "shop", sha: SHA, source: { url: TARBALL, token: INSTALLATION_TOKEN } }]);
      expect(agents[id].deploys).toEqual([]); // the build deploys; the dashboard never asks for a tag
      expect(deliveries.findDelivery("delivery-1", id, "shop")).toMatchObject({ outcome: "deployed", sha: SHA, branch: "main", runKey: `acme/shop#push#${SHA}` });
    }
    await h.settle();
  });

  it("writes one audit line", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() });
    await push(h);
    const lines = store.recentAudit(50).filter((e) => e.event === "webhook_delivery");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("Acme/Shop@aaaaaaa (push to main, build)");
    expect(lines[0].detail).toContain("staging/shop deployed");
    expect(JSON.stringify(lines)).not.toContain(INSTALLATION_TOKEN);
    await h.settle();
  });

  it("deploys a first commit to an app that serves nothing yet, without asking GitHub to compare", async () => {
    const agents = { [staging]: agentFake({ serving: null }), [production]: agentFake({ serving: null }) };
    const h = harness(agents);
    await push(h);
    expect(h.compares).toEqual([]);
    expect(agents[staging].builds).toHaveLength(1);
    await h.settle();
  });

  it("places the commit against what serves with the installation token, not the personal one", async () => {
    const agents = { [staging]: agentFake({ serving: `ghcr.io/acme/shop:${OLD}` }), [production]: agentFake({ serving: null }) };
    const h = harness(agents);
    integrations.removeGithubConnection(); // the PAT is optional
    const out = await push(h);
    expect(out.results[0]).toMatchObject({ server: "staging", outcome: "deployed" });
    expect(h.compares).toEqual([{ token: INSTALLATION_TOKEN, base: OLD, head: SHA }]);
    await h.settle();
  });

  it("builds nothing and records nothing for what is not a build of a linked branch", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["another branch", { ref: "refs/heads/feature" }, "no app builds from this push"],
      ["a branch with the linked name as a prefix", { ref: "refs/heads/main2" }, "no app builds from this push"],
      ["a tag", { ref: "refs/tags/main" }, "the push is not to a branch"],
      ["a deleted branch", { deleted: true, after: "0".repeat(40) }, "the push deletes the branch"],
      ["a push flagged as a deletion that still names a commit", { deleted: true }, "the push deletes the branch"],
      ["a deletion that says only zeros", { after: "0".repeat(40) }, "the push deletes the branch"],
      ["a push with an abbreviated commit", { after: "abc1234" }, "the push has no full commit SHA"],
      ["a push that did not come through the App", { installation: undefined }, "the push did not come through the GitHub App"],
      ["another repository", { repository: { full_name: "acme/other" } }, "no app builds from this push"],
    ];
    for (const [label, over, reason] of cases) {
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      const h = harness(agents);
      const out = await push(h, over);
      expect(out, label).toMatchObject({ ignored: reason, results: [] });
      for (const calls of everything(agents)) expect(calls, label).toEqual([]);
      expect(h.minted, label).toEqual([]);
      expect(deliveries.recentDeliveries(staging, "shop"), label).toEqual([]);
      expect(h.statuses, label).toEqual([]);
    }
  });

  it("does nothing while the mode is off, even with automatic deploys and previews on", async () => {
    integrations.setBuildModes(staging, "shop", { onPush: false, previews: true });
    integrations.setBuildModes(production, "shop", { onPush: false, previews: false });
    integrations.setAutoDeployWorkflow(production, "shop", "Build and push");
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const out = await push(harness(agents));
    expect(out).toMatchObject({ ignored: "no app builds from this push", results: [] });
    for (const calls of everything(agents)) expect(calls).toEqual([]);
  });

  it("answers 400 to a malformed payload and when it would act without a usable delivery id", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() });
    expect((await handleGithubWebhook(delivery({ ref: "refs/heads/main" }, { event: "push" }), h.deps)).status).toBe(400);
    const noId = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": signBody(secret, JSON.stringify(pushPayload())) },
      body: JSON.stringify(pushPayload()),
    });
    expect((await handleGithubWebhook(noId, h.deps)).status).toBe(400);
  });

  it("refuses a delivery whose signature is wrong, before anything is parsed", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() });
    const raw = JSON.stringify(pushPayload());
    const bad = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "d", "x-hub-signature-256": signBody("wrong", raw) },
      body: raw,
    });
    expect((await handleGithubWebhook(bad, h.deps)).status).toBe(401);
    expect(h.minted).toEqual([]);
  });
});

describe("when the App cannot act", () => {
  it("records a failure and builds nothing when the App is not configured", async () => {
    // Removing the App through the UI also turns the modes off; a stale link is modelled by deleting only the credentials.
    db().exec("DELETE FROM integrations WHERE provider = 'github-app'");
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const out = await push(h);
    expect(out.results.map((r) => [r.server, r.outcome, r.detail])).toEqual([
      ["staging", "failed", "the GitHub App is not configured in this dashboard"],
      ["production", "failed", "the GitHub App is not configured in this dashboard"],
    ]);
    for (const calls of everything(agents)) expect(calls).toEqual([]);
    expect(h.minted).toEqual([]);
    const preview = await pull(h, "opened", {}, "d-pr");
    expect(preview.results[0]).toMatchObject({ app: "shop-pr-12", outcome: "failed", detail: "the GitHub App is not configured in this dashboard" });
  });

  it("says why when no installation token can be made, and builds nothing", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents, { installationToken: async () => Promise.reject(new GithubAppError("The GitHub App is not installed on acme/shop: install it on that repository from the App's page on GitHub.", 404)) });
    const out = await push(h);
    expect(out.results).toMatchObject([
      { outcome: "failed", detail: expect.stringContaining("not installed on acme/shop") },
      { outcome: "failed", detail: expect.stringContaining("not installed on acme/shop") },
    ]);
    for (const calls of everything(agents)) expect(calls).toEqual([]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")?.outcome).toBe("failed");
  });

  it("gives up on a token GitHub is too slow to mint, and on an unexpected error, without leaking it", async () => {
    const slow = harness({ [staging]: agentFake(), [production]: agentFake() }, { installationToken: () => new Promise<never>(() => {}), tokenBudgetMs: 20 });
    expect((await push(slow)).results[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining("did not answer in time") });
    const odd = harness({ [staging]: agentFake(), [production]: agentFake() }, { installationToken: async () => Promise.reject(new Error(`boom ${INSTALLATION_TOKEN}`)) });
    const out = await push(odd, {}, "d2");
    expect(out.results[0]).toMatchObject({ outcome: "failed", detail: "unexpected error creating the GitHub App's installation token" });
    expect(JSON.stringify(out)).not.toContain(INSTALLATION_TOKEN);
  });
});

describe("what the agent says", () => {
  const cases: [string, AgentError, RegExp][] = [
    ["an app with no build: block", new AgentError(400, "app shop has no build: block"), /^the agent cannot build this app: app shop has no build: block$/],
    ["a busy agent", new AgentError(409, "busy"), /^a deployment or build is already running on the agent$/],
    ["an unknown app or an old agent", new AgentError(404, "not found"), /not on this server, or the agent is too old/],
    ["a shutting down agent", new AgentError(503, "shutting down"), /shutting down/],
    ["a refused signature", new AgentError(401, "bad signature"), /check the server's deploy secret/],
    ["an unreachable agent", new AgentError(0, "cannot reach the agent: connection refused"), /cannot reach the agent/],
  ];
  for (const [label, error, detail] of cases) {
    it(`records ${label} as a failure with the agent's words`, async () => {
      const agents = { [staging]: agentFake({ buildError: error }), [production]: agentFake() };
      const h = harness(agents);
      const out = await push(h);
      expect(out.results[0]).toMatchObject({ server: "staging", outcome: "failed", detail: expect.stringMatching(detail) });
      expect(out.results[1]).toMatchObject({ server: "production", outcome: "deployed" }); // the other server is not affected
      await h.settle();
    });
  }

  it("never shows the source token even when the agent echoes it", async () => {
    const agents = { [staging]: agentFake({ buildError: new AgentError(400, `cannot download with ${INSTALLATION_TOKEN}`) }), [production]: agentFake() };
    const out = await push(harness(agents));
    expect(out.results[0]!.detail).toBe("the agent cannot build this app: cannot download with [redacted]");
    expect(JSON.stringify(db().prepare("SELECT * FROM webhook_deliveries").all())).not.toContain(INSTALLATION_TOKEN);
  });

  it("answers within its budget when the agent does not answer the build request, records unknown, and does not build again", async () => {
    const agents = { [staging]: agentFake({ buildError: "hang" }), [production]: agentFake() };
    const h = harness(agents, { deployBudgetMs: 20 });
    const out = await push(h);
    expect(out.results[0]).toMatchObject({ outcome: "unknown", detail: expect.stringContaining("the build may have started") });
    // A redelivery while the app cannot be read keeps it unknown instead of building a second time.
    agents[staging].apps = new AgentError(0, "cannot reach the agent");
    agents[staging].buildError = undefined;
    const again = await push(harness(agents), {}, "delivery-1");
    expect(again.results[0]).toMatchObject({ outcome: "unknown" });
    expect(agents[staging].builds).toEqual([]);
  });

  it("answers within its budget when the app lookup hangs, failing the one server", async () => {
    const agents = { [staging]: agentFake({ apps: "hang" }), [production]: agentFake() };
    const out = await push(harness(agents, { budgetMs: 20 }));
    expect(out.results[0]).toMatchObject({ outcome: "failed", detail: "the agent did not answer in time" });
    expect(out.results[1]).toMatchObject({ outcome: "deployed" });
  });

  it("fails clearly when the app is not on the server, deployments are off, or the server has no deploy secret", async () => {
    const agents = { [staging]: agentFake({ apps: "disabled" }), [production]: agentFake() };
    expect((await push(harness(agents))).results[0]).toMatchObject({ outcome: "failed", detail: "deployments are not enabled on this server" });
    const secretOf = db().prepare("SELECT deploy_secret_enc FROM servers WHERE id = ?").get(production) as { deploy_secret_enc: string };
    db().prepare("UPDATE servers SET deploy_secret_enc = NULL WHERE id = ?").run(production);
    try {
      const out = await push(harness(agents), {}, "d2");
      expect(out.results[1]).toMatchObject({ outcome: "failed", detail: "this server has no deploy secret in the dashboard" });
    } finally {
      db().prepare("UPDATE servers SET deploy_secret_enc = ? WHERE id = ?").run(secretOf.deploy_secret_enc, production);
    }
  });
});

describe("which pushes are skipped", () => {
  it("skips a commit that already serves", async () => {
    const agents = { [staging]: agentFake({ serving: `ghcr.io/acme/shop:${SHA}` }), [production]: agentFake() };
    const out = await push(harness(agents));
    expect(out.results[0]).toMatchObject({ outcome: "skipped", detail: "already serving" });
    expect(agents[staging].builds).toEqual([]);
  });

  it("skips a commit GitHub proves older, one it cannot place, and a diverged history", async () => {
    for (const [compare, serving, reason] of [
      [async () => ({ aheadBy: 0, behindBy: 3 }), `x:${OLD}`, "older than what is serving"],
      [async () => ({ aheadBy: 2, behindBy: 3 }), `x:${OLD}`, "diverged"],
      [async () => null, `x:${OLD}`, "failed or timed out"],
      [async () => ({ aheadBy: 1, behindBy: 0 }), "x:latest", "not tagged with a commit"],
    ] as const) {
      db().exec("DELETE FROM webhook_deliveries");
      const agents = { [staging]: agentFake({ serving }), [production]: agentFake() };
      const out = await push(harness(agents, { compare }));
      expect(out.results[0], reason).toMatchObject({ outcome: "skipped", detail: expect.stringContaining(reason) });
      expect(agents[staging].builds, reason).toEqual([]);
    }
  });

  it("builds a commit that is ahead of what serves", async () => {
    const agents = { [staging]: agentFake({ serving: `x:${OLD}` }), [production]: agentFake() };
    expect((await push(harness(agents))).results[0]).toMatchObject({ outcome: "deployed" });
    expect(agents[staging].builds).toHaveLength(1);
  });
});

describe("redeliveries and concurrent deliveries", () => {
  it("builds once for a redelivery under the same delivery id, answering what was stored", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const first = await push(harness(agents));
    const again = await push(harness(agents));
    expect(again.results).toEqual(first.results);
    expect(agents[staging].builds).toHaveLength(1);
    expect(agents[production].builds).toHaveLength(1);
  });

  it("builds once for the same push under another delivery id", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await push(harness(agents), {}, "a");
    const second = await push(harness(agents), {}, "b");
    expect(second.results[0]).toMatchObject({ outcome: "deployed", deployment_id: "build-staging-1" });
    expect(agents[staging].builds).toHaveLength(1);
  });

  it("builds once when two deliveries of the same push arrive together", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const [a, b] = await Promise.all([push(harness(agents), {}, "a"), push(harness(agents), {}, "b")]);
    expect(agents[staging].builds).toHaveLength(1);
    expect(agents[production].builds).toHaveLength(1);
    // The one that lost the claim says what the winner is doing.
    expect([a.results[0]!.outcome, b.results[0]!.outcome].sort()).toEqual(["deployed", "pending"]);
  });

  it("builds a new commit under a new delivery", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await push(harness(agents), {}, "a");
    agents[staging].serving = `x:${SHA}`;
    await push(harness(agents), { after: OTHER, before: SHA }, "b");
    expect(agents[staging].builds.map((b) => b.sha)).toEqual([SHA, OTHER]);
  });
});

describe("a CI workflow and a push of the same commit", () => {
  const withCi = () => {
    integrations.setAutoDeployWorkflow(production, "shop", "Build and push");
    integrations.setAutoDeployWorkflow(staging, "shop", "Build and push");
  };

  it("never both deploy: the CI run that finishes while the build runs is skipped", async () => {
    withCi();
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const build = harness(agents);
    await push(build, {}, "push-1");
    // The agent still serves the old version while it builds; the CI workflow for the same commit now completes.
    const ci = harness(agents, { agent: (server) => ({ apps: async () => [{ name: "shop", container: null }] as never, deploy: async (app, target) => { agents[server.id]!.deploys.push({ app, tag: (target as { tag: string }).tag }); return "ci-dep"; } }) });
    const out = await send(ci, runPayload(), "workflow_run", "ci-1");
    expect(out.results.map((r) => [r.server, r.outcome, r.detail])).toEqual([
      ["staging", "skipped", "a GitHub App build of this commit has started deploying it"],
      ["production", "skipped", "a GitHub App build of this commit has started deploying it"],
    ]);
    for (const a of Object.values(agents)) expect(a.deploys).toEqual([]);
    expect(agents[staging].builds).toHaveLength(1);
    await build.settle();
  });

  it("is not blocked once the build failed: the CI deploy of the commit goes ahead", async () => {
    withCi();
    const agents = { [staging]: agentFake({ deploymentStatuses: ["failed"], deploymentError: "compile error" }), [production]: agentFake({ deploymentStatuses: ["failed"], deploymentError: "compile error" }) };
    const build = harness(agents);
    await push(build, {}, "push-1");
    await build.settle();
    expect(deliveries.findDelivery("push-1", staging, "shop")).toMatchObject({ outcome: "failed", detail: expect.stringContaining("compile error") });

    const ci = harness(agents, { agent: (server) => ({ apps: async () => [{ name: "shop", container: null }] as never, deploy: async (app, target) => { agents[server.id]!.deploys.push({ app, tag: (target as { tag: string }).tag }); return "ci-dep"; } }) });
    const out = await send(ci, runPayload(), "workflow_run", "ci-1");
    expect(out.results.map((r) => r.outcome)).toEqual(["deployed", "deployed"]);
    expect(agents[staging].deploys).toEqual([{ app: "shop", tag: SHA }]);
  });

  it("is not blocked for another commit, nor after the hold has passed", async () => {
    withCi();
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await push(harness(agents), {}, "push-1");
    const ci = (deliveryId: string, sha: string, run: number) => ({ deliveryId, repo: "acme/shop", branch: "main", sha, serverId: staging, app: "shop", runKey: `acme/shop#${run}#1` });
    expect(deliveries.claimDelivery(ci("ci-held", SHA, 302))).toMatchObject({ claimed: false, heldByBuild: true });
    expect(deliveries.claimDelivery(ci("ci-x", OTHER, 300))).toEqual({ claimed: true });
    expect(deliveries.claimDelivery(ci("ci-y", SHA, 301), Date.now() + deliveries.BUILD_HOLD_MS + 1000)).toEqual({ claimed: true });
  });

  it("holds a pull request's preview the same way against the preview workflow of the same commit", async () => {
    integrations.setPreviewsWorkflow(staging, "shop", "Build and push");
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await pull(harness(agents));
    const ci = harness(agents, {
      previewAgent: () => ({
        previews: async () => [],
        deployPreview: async () => {
          throw new Error("must not be asked");
        },
        deletePreview: async () => {},
        deployment: async () => ({ status: "succeeded" }) as never,
      }),
    });
    const out = await send(ci, runPayload({ event: "pull_request", head_branch: "feature", pull_requests: [{ number: 12, base: { ref: "main" } }] }), "workflow_run", "ci-pr");
    expect(out.results).toMatchObject([{ app: "shop-pr-12", outcome: "skipped", detail: "a GitHub App build of this commit has started deploying it" }]);
  });
});

describe("a pull request of the repository itself", () => {
  it("builds its preview from the head commit on the server that builds previews, naming it after the app and the number", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const out = await pull(h);
    expect(out.results).toEqual([
      {
        server: "staging",
        app: "shop-pr-12",
        outcome: "deployed",
        detail: "preview build and deployment started: https://pr-12-shop.example.com",
        deployment_id: "pbuild-staging-1",
      },
    ]);
    expect(agents[staging].previewBuilds).toEqual([{ app: "shop", pr: 12, sha: SHA, source: { url: TARBALL, token: INSTALLATION_TOKEN } }]);
    expect(agents[production].previewBuilds).toEqual([]);
    expect(agents[staging].builds).toEqual([]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "deployed", sha: SHA, branch: "feature", runKey: `acme/shop#pr12#${SHA}` });
    expect(h.pullChecks).toEqual([{ token: INSTALLATION_TOKEN, n: 12 }]); // the App's token, not the personal one
    await h.settle();
  });

  for (const action of ["opened", "reopened", "synchronize"]) {
    it(`builds on ${action}`, async () => {
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      const h = harness(agents);
      expect((await pull(h, action)).results[0]).toMatchObject({ outcome: "deployed" });
      expect(agents[staging].previewBuilds).toHaveLength(1);
      await h.settle();
    });
  }

  it("does nothing for a fork, a deleted head repository or a base that is not the linked branch", async () => {
    const cases: [string, Parameters<typeof pullPayload>[1], string][] = [
      ["a fork", { pull: { head: { sha: SHA, ref: "feature", repo: { full_name: "mallory/shop" } } } }, "the pull request comes from a fork"],
      ["a deleted fork", { pull: { head: { sha: SHA, ref: "feature", repo: null } } }, "the pull request comes from a fork"],
      ["a base in another repository", { pull: { base: { ref: "main", repo: { full_name: "acme/other" } } } }, "the pull request comes from a fork"],
      ["a fork of the same name in another case", { pull: { head: { sha: SHA, ref: "feature", repo: { full_name: "Acme/Shop-fork" } } } }, "the pull request comes from a fork"],
      ["a base that is not the linked branch", { pull: { base: { ref: "release", repo: { full_name: "Acme/Shop" } } } }, "no app builds previews from this pull request"],
      ["no installation", { top: { installation: undefined } }, "the pull request did not come through the GitHub App"],
      ["an abbreviated commit", { pull: { head: { sha: "abc1234", ref: "feature", repo: { full_name: "Acme/Shop" } } } }, "the pull request has no full commit SHA"],
      ["no head", { pull: { head: null } }, "the pull request comes from a fork"],
      ["an out-of-range number", { pull: { number: 1_000_000 } }, "the pull request number is out of range"],
    ];
    for (const [label, over, reason] of cases) {
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      const h = harness(agents);
      const out = await pull(h, "opened", over);
      expect(out, label).toMatchObject({ ignored: reason, results: [] });
      for (const calls of everything(agents)) expect(calls, label).toEqual([]);
      expect(deliveries.recentPreviewDeliveries(staging, "shop"), label).toEqual([]);
      expect(h.minted, label).toEqual([]);
    }
  });

  it("matches the repository whatever its letter case", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents);
    const out = await pull(h, "opened", { top: { repository: { full_name: "ACME/SHOP" } }, pull: { head: { sha: SHA, ref: "f", repo: { full_name: "acme/shop" } }, base: { ref: "main", repo: { full_name: "ACME/shop" } } } });
    expect(out.results[0]).toMatchObject({ outcome: "deployed" });
    await h.settle();
  });

  it("does nothing while the mode is off, even with automatic deploys and a previews workflow", async () => {
    integrations.setBuildModes(staging, "shop", { onPush: true, previews: false });
    integrations.setPreviewsWorkflow(staging, "shop", "Build and push");
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const out = await pull(harness(agents));
    expect(out).toMatchObject({ ignored: "no app builds previews from this pull request", results: [] });
    for (const calls of everything(agents)) expect(calls).toEqual([]);
  });

  it("ignores the other actions", async () => {
    for (const action of ["edited", "labeled", "assigned", "ready_for_review", "converted_to_draft"]) {
      const agents = { [staging]: agentFake(), [production]: agentFake() };
      expect(await pull(harness(agents), action, {}, `d-${action}`), action).toMatchObject({ ignored: "only opened, reopened and updated pull requests are built", results: [] });
      for (const calls of everything(agents)) expect(calls, action).toEqual([]);
    }
  });

  it("skips a pull request that was closed or moved on meanwhile, and one that already serves the commit", async () => {
    const closed = harness({ [staging]: agentFake(), [production]: agentFake() }, { pullRequest: async () => ({ open: false, merged: true, headSha: SHA }) });
    expect((await pull(closed)).results[0]).toMatchObject({ outcome: "skipped", detail: "pull request is closed" });
    const moved = harness({ [staging]: agentFake(), [production]: agentFake() }, { pullRequest: async () => ({ open: true, merged: false, headSha: OLD }) });
    expect((await pull(moved, "synchronize", {}, "d2")).results[0]).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("newer push") });
    const serving = agentFake({ instances: [{ name: "shop-pr-12", ref: `ghcr.io/acme/shop:${SHA}`, status: "running" }] });
    expect((await pull(harness({ [staging]: serving, [production]: agentFake() }), "synchronize", {}, "d3")).results[0]).toMatchObject({ outcome: "skipped", detail: "already serving" });
    expect(serving.previewBuilds).toEqual([]);
  });

  it("builds again a preview whose last deployment failed, even at the same commit", async () => {
    const failed = agentFake({ instances: [{ name: "shop-pr-12", ref: `ghcr.io/acme/shop:${SHA}`, status: "failed" }] });
    const h = harness({ [staging]: failed, [production]: agentFake() });
    expect((await pull(h)).results[0]).toMatchObject({ outcome: "deployed" });
    expect(failed.previewBuilds).toHaveLength(1);
    await h.settle();
  });

  it("proceeds, and says so, when GitHub cannot say whether the pull request is still open", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() }, { pullRequest: async () => null });
    const out = await pull(h);
    expect(out.results[0]).toMatchObject({ outcome: "deployed", detail: expect.stringContaining("pull request state not checked") });
    await h.settle();
  });

  it("fails clearly when the agent has no previews, no template, or no build block", async () => {
    const none = harness({ [staging]: agentFake({ previews: "disabled" }), [production]: agentFake() });
    expect((await pull(none)).results[0]).toMatchObject({ outcome: "failed", detail: "previews are not available on this server" });
    const noTemplate = harness({ [staging]: agentFake({ buildError: new AgentError(404, "no preview template") }), [production]: agentFake() });
    expect((await pull(noTemplate, "opened", {}, "d2")).results[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining("no preview template") });
    const noBuild = harness({ [staging]: agentFake({ buildError: new AgentError(400, "app shop has no build: block") }), [production]: agentFake() });
    expect((await pull(noBuild, "opened", {}, "d3")).results[0]).toMatchObject({ outcome: "failed", detail: "the agent cannot build this preview: app shop has no build: block" });
    const hang = harness({ [staging]: agentFake({ buildError: "hang" }), [production]: agentFake() }, { deployBudgetMs: 20 });
    expect((await pull(hang, "opened", {}, "d4")).results[0]).toMatchObject({ outcome: "unknown" });
  });

  it("builds once for a redelivery, for the same pull request commit under another delivery id, and when two arrive together", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    await pull(harness(agents), "opened", {}, "a");
    await pull(harness(agents), "opened", {}, "a");
    await pull(harness(agents), "synchronize", {}, "b");
    await Promise.all([pull(harness(agents), "synchronize", {}, "c"), pull(harness(agents), "synchronize", {}, "d")]);
    expect(agents[staging].previewBuilds).toHaveLength(1);
  });

  it("removes the preview when the pull request is closed, for an app that builds previews and has no previews workflow", async () => {
    const deletes: [string, number][] = [];
    const h = harness({ [staging]: agentFake(), [production]: agentFake() }, {
      previewAgent: () => ({
        previews: async () => [],
        deployPreview: async () => {
          throw new Error("no");
        },
        deletePreview: async (app, n) => void deletes.push([app, n]),
        deployment: async () => ({ status: "succeeded" }) as never,
      }),
    });
    const out = await send(h, pullPayload("closed"), "pull_request");
    expect(out.results).toMatchObject([{ server: "staging", app: "shop-pr-12", outcome: "removed" }]);
    expect(deletes).toEqual([["shop", 12]]);
  });
});

describe("the commit status of a build", () => {
  const deployedOnce = async (h: Harness) => {
    await push(h);
    await h.settle();
  };

  it("shows keelson/build pending, then success linking the deployment's page, written with the installation token", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["running", "running", "succeeded"] }), [production]: agentFake() };
    const h = harness(agents);
    await deployedOnce(h);
    expect(h.statuses.every((s) => s.kind === "build" && s.token === INSTALLATION_TOKEN && s.repo === "Acme/Shop" && s.sha === SHA)).toBe(true);
    const forStaging = h.statuses.filter((s) => s.targetUrl === `https://keelson.example.com/servers/${staging}/deployments/build-staging-1`);
    expect(forStaging.map((s) => [s.state, s.description])).toEqual([
      ["pending", "Building"],
      ["success", "Built and deployed"],
    ]);
    expect(h.statuses.some((s) => s.token === "ghp_read_only_pat")).toBe(false);
  });

  it("posts without a link when the dashboard does not know its address", async () => {
    const agents = { [staging]: agentFake(), [production]: agentFake() };
    const h = harness(agents, { publicUrl: () => null });
    await deployedOnce(h);
    expect(h.statuses.length).toBeGreaterThan(0);
    expect(h.statuses.every((s) => s.targetUrl === undefined)).toBe(true);
  });

  it("shows a failed build as a failure with the reason, and frees the row", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["running", "failed"], deploymentError: "docker build: exit 1" }), [production]: agentFake() };
    const h = harness(agents);
    await deployedOnce(h);
    const failure = h.statuses.find((s) => s.state === "failure" && s.description.includes("docker build: exit 1"));
    expect(failure).toMatchObject({ kind: "build", description: "Build or deploy failed: docker build: exit 1" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "failed", detail: expect.stringContaining("docker build: exit 1") });
    // And a redelivery under the same id builds again.
    const retry = harness(agents);
    await push(retry);
    expect(agents[staging].builds).toHaveLength(2);
    await retry.settle();
  });

  it("gives up following with the injected clock, reports it, and leaves the delivery as deployed", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: Array(1000).fill("running") }), [production]: agentFake() };
    const h = harness(agents, { pollIntervalMs: 1000, pollTimeoutMs: 5000 });
    await deployedOnce(h);
    const last = h.statuses.filter((s) => s.targetUrl?.includes(`/servers/${staging}/`)).at(-1);
    expect(last).toMatchObject({ state: "failure", description: "Did not finish in time; check Keelson" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop")?.outcome).toBe("deployed");
  });

  it("notes in the delivery, without failing it, when the status cannot be written or the token cannot be made again", async () => {
    const denied = harness({ [staging]: agentFake(), [production]: agentFake() }, { statusError: new Error("The token cannot write commit statuses") });
    await deployedOnce(denied);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed", detail: expect.stringContaining("status not reported: The token cannot write commit statuses") });

    db().exec("DELETE FROM webhook_deliveries");
    const expired = harness({ [staging]: agentFake(), [production]: agentFake() }, { failSecondToken: true });
    await deployedOnce(expired);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed", detail: expect.stringContaining("status not reported: The GitHub App is not installed") });
  });

  it("works when the status cannot be scheduled", async () => {
    const h = harness({ [staging]: agentFake(), [production]: agentFake() }, {
      background: () => {
        throw new Error("no scheduler");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await push(h)).results[0]).toMatchObject({ outcome: "deployed" });
    vi.restoreAllMocks();
  });
});

describe("the status of a preview build", () => {
  it("shows keelson/preview building, then success linking the preview, written with the installation token", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["running", "succeeded"] }), [production]: agentFake() };
    const h = harness(agents);
    await pull(h);
    await h.settle();
    expect(h.statuses.map((s) => [s.kind, s.token, s.state, s.description, s.targetUrl])).toEqual([
      ["preview", INSTALLATION_TOKEN, "pending", "Preview building and deploying", undefined],
      ["preview", INSTALLATION_TOKEN, "success", "Preview deployed", "https://pr-12-shop.example.com"],
    ]);
  });

  it("shows a failed preview build as a failure and frees the commit", async () => {
    const agents = { [staging]: agentFake({ deploymentStatuses: ["failed"], deploymentError: "no space left" }), [production]: agentFake() };
    const h = harness(agents);
    await pull(h);
    await h.settle();
    expect(h.statuses.at(-1)).toMatchObject({ state: "failure", description: "Preview build or deploy failed: no space left" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop-pr-12")).toMatchObject({ outcome: "failed", detail: expect.stringContaining("no space left") });
  });
});

describe("the token is never kept", () => {
  it("appears in no stored row, audit line, answer or log line of a whole push and pull request flow", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    const agents = { [staging]: agentFake({ buildError: new AgentError(409, `busy ${INSTALLATION_TOKEN}`) }), [production]: agentFake() };
    const h = harness(agents);
    const a = await push(h);
    const b = await pull(h, "opened", {}, "d2");
    await h.settle();
    const dump = JSON.stringify([a, b, db().prepare("SELECT * FROM webhook_deliveries").all(), db().prepare("SELECT * FROM audit_log").all(), db().prepare("SELECT * FROM integrations").all(), logged]);
    expect(dump).not.toContain(INSTALLATION_TOKEN);
    vi.restoreAllMocks();
  });
});
