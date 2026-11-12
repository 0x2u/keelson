import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";
import type { WebhookDeps } from "@/lib/github-webhook";
import { signBody } from "@/lib/github-webhook-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-webhook-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// Imported after the data dir is set: the database opens lazily on first use.
const { db } = await import("@/lib/db");
const { handleGithubWebhook } = await import("@/lib/github-webhook");
const { POST } = await import("@/app/api/webhooks/github/route");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const NEWER = "c".repeat(40);

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
  integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "main" });
  integrations.setAutoDeployWorkflow(staging, "shop", "Build and push");
  integrations.setAppRepo(production, "shop", { repo: "Acme/Shop", branch: "main" });
  integrations.setAutoDeployWorkflow(production, "shop", "Build and push");
});

interface FakeAgent {
  serving: string | null;
  deployError?: AgentError;
  appsError?: AgentError;
  deploys: { app: string; tag: string }[];
}

function fakes(agents: Record<string, FakeAgent>, compare: WebhookDeps["compare"] = async () => ({ aheadBy: 1, behindBy: 0 })) {
  const deps: WebhookDeps = {
    agent: (server) => {
      const fake = agents[server.id]!;
      return {
        apps: async () => {
          if (fake.appsError) throw fake.appsError;
          return [{ name: "shop", image: "", project: "", environment: "", digest: "", container: fake.serving === null ? null : ({ image: fake.serving } as never), last_deployment: null }];
        },
        deploy: async (app, target) => {
          if (fake.deployError) throw fake.deployError;
          if (!("tag" in target) || !target.tag) throw new Error("expected a tag");
          fake.deploys.push({ app, tag: target.tag });
          return `dep-${server.name}-${fake.deploys.length}`;
        },
      };
    },
    compare,
  };
  return deps;
}

function runPayload(over: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "Acme/Shop" },
    workflow_run: { id: 100, run_attempt: 1, name: "Build and push", conclusion: "success", event: "push", head_sha: SHA, head_branch: "main", head_repository: { full_name: "Acme/Shop" }, ...over },
  };
}

function delivery(body: unknown, opts: { event?: string; id?: string; secret?: string; type?: string; signature?: string | null } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": opts.type ?? "application/json",
    "x-github-event": opts.event ?? "workflow_run",
    "x-github-delivery": opts.id ?? "delivery-1",
  };
  if (opts.signature !== null) headers["x-hub-signature-256"] = opts.signature ?? signBody(opts.secret ?? secret, raw);
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body: raw });
}

describe("the route's gates", () => {
  it("is 404 when no secret is configured, before anything is read", async () => {
    integrations.removeWebhookSecret();
    expect((await POST(delivery(runPayload()))).status).toBe(404);
  });

  it("asks for application/json", async () => {
    const res = await POST(delivery(runPayload(), { type: "application/x-www-form-urlencoded" }));
    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).toContain("application/json");
    expect((await POST(delivery(runPayload(), { type: "application/json; charset=utf-8" }))).status).not.toBe(415);
  });

  it("is 401 for a missing or wrong signature, without detail, and never reads the database for the body", async () => {
    for (const request of [delivery(runPayload(), { signature: null }), delivery(runPayload(), { secret: "wrong" }), delivery(runPayload(), { signature: "sha256=00" })]) {
      const res = await POST(request);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(deliveries.recentDeliveries(staging, "shop")).toEqual([]);
  });

  it("checks the signature before looking at the JSON: garbage with a bad signature is 401, with a good one 400", async () => {
    expect((await POST(delivery("{not json", { secret: "wrong" }))).status).toBe(401);
    expect((await POST(delivery("{not json"))).status).toBe(400);
  });

  it("is 413 above 1 MiB, by declared length and by actual bytes", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    expect((await POST(delivery(big))).status).toBe(413);
    const streamed = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signBody(secret, big) },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      // @ts-expect-error Node's fetch needs this for a streamed body
      duplex: "half",
    });
    expect((await POST(streamed)).status).toBe(413);
  });

  it("answers ping, and ignores other events", async () => {
    const ping = await POST(delivery({ zen: "x" }, { event: "ping" }));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true });
    const other = await POST(delivery({ action: "created" }, { event: "issues" }));
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ ignored: "event not used", results: [] });
    expect(deliveries.recentDeliveries(staging, "shop")).toEqual([]);
  });

  it("is 400 for a workflow_run that is malformed", async () => {
    expect((await POST(delivery({ action: "completed" }))).status).toBe(400);
  });
});

describe("deploying", () => {
  it("deploys the commit's tag to every linked app that matches, on any server, and records each", async () => {
    const agents = { [staging]: { serving: `ghcr.io/acme/shop:${OLD}`, deploys: [] }, [production]: { serving: `ghcr.io/acme/shop:${OLD}`, deploys: [] } };
    const res = await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { server: string; app: string; outcome: string; deployment_id?: string }[] };
    expect(body.results.map((r) => `${r.server}/${r.app}:${r.outcome}`).sort()).toEqual(["production/shop:deployed", "staging/shop:deployed"]);
    expect(agents[staging].deploys).toEqual([{ app: "shop", tag: SHA }]);
    expect(agents[production].deploys).toEqual([{ app: "shop", tag: SHA }]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed", sha: SHA, deploymentId: expect.stringMatching(/^dep-/) });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("leaves alone apps whose workflow, branch or switch does not match", async () => {
    integrations.setAutoDeployWorkflow(production, "shop", "Another workflow");
    integrations.setAutoDeployWorkflow(staging, "shop", "Build and push");
    const agents = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    expect(agents[staging].deploys).toHaveLength(1);
    expect(agents[production].deploys).toHaveLength(0);

    const res = await handleGithubWebhook(delivery(runPayload({ head_branch: "feature" }), { id: "d2" }), fakes(agents));
    expect(await res.json()).toMatchObject({ results: [] });
    expect(agents[staging].deploys).toHaveLength(1);
  });

  it("never deploys fork or pull request runs, nor failed ones", async () => {
    const agents = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    for (const over of [{ head_repository: { full_name: "mallory/shop" } }, { event: "pull_request" }, { conclusion: "failure" }, { head_sha: "abc1234" }]) {
      await handleGithubWebhook(delivery(runPayload(over)), fakes(agents));
    }
    expect(agents[staging].deploys).toHaveLength(0);
    expect(deliveries.recentDeliveries(staging, "shop")).toEqual([]);
  });

  it("skips what is already serving, and a run older than what is serving", async () => {
    const agents = { [staging]: { serving: `ghcr.io/acme/shop:${SHA}`, deploys: [] }, [production]: { serving: `ghcr.io/acme/shop:${NEWER}`, deploys: [] } };
    store.audit("noise");
    integrations.saveGithubConnection("ghp_x", "me");
    const compare = vi.fn<WebhookDeps["compare"]>(async () => ({ aheadBy: 0, behindBy: 2 }));
    const res = await handleGithubWebhook(delivery(runPayload()), fakes(agents, compare));
    const { results } = (await res.json()) as { results: { server: string; outcome: string; detail: string }[] };
    expect(results.find((r) => r.server === "staging")).toMatchObject({ outcome: "skipped", detail: "already serving" });
    expect(results.find((r) => r.server === "production")).toMatchObject({ outcome: "skipped", detail: "older than what is serving" });
    expect(agents[staging].deploys).toHaveLength(0);
    expect(agents[production].deploys).toHaveLength(0);
    expect(compare).toHaveBeenCalledWith("ghp_x", "Acme/Shop", NEWER, SHA);
  });

  it("skips, with the order unknown as the reason, when GitHub cannot compare, and records it", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const compare: WebhookDeps["compare"] = async () => {
      throw new Error("rate limited");
    };
    const { results } = (await (await handleGithubWebhook(delivery(runPayload()), fakes(agents, compare))).json()) as { results: { outcome: string; detail: string }[] };
    for (const r of results) {
      expect(r.outcome).toBe("skipped");
      expect(r.detail).toMatch(/ordering unknown/);
    }
    expect(agents[staging].deploys).toHaveLength(0);
    expect(agents[production].deploys).toHaveLength(0);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("ordering unknown") });
  });

  it("gives the comparison a budget of its own, however long the lookup took", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const base = fakes(agents, () => new Promise(() => {}));
    const deps: WebhookDeps = {
      ...base,
      budgetMs: 1000,
      compareBudgetMs: 40,
      agent: (server) => ({ ...base.agent(server), apps: async () => (await new Promise((r) => setTimeout(r, 30)), base.agent(server).apps()) }),
    };
    const started = Date.now();
    const { results } = (await (await handleGithubWebhook(delivery(runPayload()), deps)).json()) as { results: { outcome: string; detail: string }[] };
    expect(Date.now() - started).toBeLessThan(900);
    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(results[0]!.detail).toContain("failed or timed out");
  });

  it("skips without a GitHub token when the app serves a commit, and does not compare", async () => {
    integrations.removeGithubConnection();
    const compare = vi.fn<WebhookDeps["compare"]>(async () => null);
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const { results } = (await (await handleGithubWebhook(delivery(runPayload()), fakes(agents, compare))).json()) as { results: { outcome: string; detail: string }[] };
    expect(compare).not.toHaveBeenCalled();
    expect(agents[staging].deploys).toHaveLength(0);
    expect(results[0]).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("no GitHub token") });
  });

  it("skips when the serving image is not tagged with a commit, but deploys the first time (nothing serving), token or not", async () => {
    const tagged = { [staging]: { serving: "ghcr.io/acme/shop:v1", deploys: [] }, [production]: { serving: null, deploys: [] } };
    integrations.removeGithubConnection();
    const { results } = (await (await handleGithubWebhook(delivery(runPayload()), fakes(tagged))).json()) as { results: { server: string; outcome: string; detail: string }[] };
    expect(results.find((r) => r.server === "staging")).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("not tagged with a commit") });
    expect(results.find((r) => r.server === "production")?.outcome).toBe("deployed");
    expect(tagged[staging].deploys).toHaveLength(0);
  });

  it("skips a diverged history instead of deploying", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const { results } = (await (await handleGithubWebhook(delivery(runPayload()), fakes(agents, async () => ({ aheadBy: 2, behindBy: 1 })))).json()) as {
      results: { outcome: string; detail: string }[];
    };
    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(results[0]!.detail).toContain("diverged");
    expect(agents[staging].deploys).toHaveLength(0);
  });

  it("reports agent errors as failed, with a readable detail", async () => {
    const agents = {
      [staging]: { serving: null, deploys: [], deployError: new AgentError(409, "busy") },
      [production]: { serving: null, deploys: [], appsError: new AgentError(0, "cannot reach the agent: connection refused") },
    };
    const res = await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    const { results } = (await res.json()) as { results: { server: string; outcome: string; detail: string }[] };
    expect(results.find((r) => r.server === "staging")).toMatchObject({ outcome: "failed", detail: "a deployment is already running" });
    expect(results.find((r) => r.server === "production")).toMatchObject({ outcome: "failed", detail: "cannot reach the agent: connection refused" });
  });

  it("writes one audit line per delivery that acted, without the secret", async () => {
    const agents = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    await handleGithubWebhook(delivery(runPayload({ head_branch: "feature" }), { id: "d2" }), fakes(agents));
    const lines = store.recentAudit(50).filter((e) => e.event === "webhook_delivery");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("Acme/Shop@aaaaaaa");
    expect(lines[0].detail).toContain("staging/shop deployed");
    expect(JSON.stringify(lines)).not.toContain(secret);
  });
});

describe("answer time", () => {
  const runOnBoth = (deps: WebhookDeps) => handleGithubWebhook(delivery(runPayload()), deps);

  it("turns an agent that never answers into a recorded failure within the budget, and the others still deploy", async () => {
    const healthy: FakeAgent = { serving: null, deploys: [] };
    const base = fakes({ [staging]: healthy, [production]: healthy });
    const deps: WebhookDeps = {
      ...base,
      budgetMs: 80,
      agent: (server) => (server.id === production ? { apps: () => new Promise(() => {}), deploy: () => new Promise(() => {}) } : base.agent(server)),
    };
    const started = Date.now();
    const res = await runOnBoth(deps);
    expect(Date.now() - started).toBeLessThan(1500);
    const { results } = (await res.json()) as { results: { server: string; outcome: string; detail: string }[] };
    expect(results.find((r) => r.server === "production")).toMatchObject({ outcome: "failed", detail: "the agent did not answer in time" });
    expect(results.find((r) => r.server === "staging")?.outcome).toBe("deployed");
    expect(deliveries.findDelivery("delivery-1", production, "shop")).toMatchObject({ outcome: "failed", detail: "the agent did not answer in time" });
  });

  it("bounds the request for the deployment too", async () => {
    const base = fakes({ [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } });
    const deps: WebhookDeps = { ...base, deployBudgetMs: 50, agent: (server) => ({ apps: base.agent(server).apps, deploy: () => new Promise(() => {}) }) };
    const { results } = (await (await runOnBoth(deps)).json()) as { results: { outcome: string; detail: string }[] };
    // No answer to the deploy request does not mean it did not start: recorded as unknown, not failed.
    expect(results.map((r) => r.outcome)).toEqual(["unknown", "unknown"]);
    expect(results[0]!.detail).toContain("may have started");
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "unknown" });
  });

  it("handles the targets concurrently: each lookup waits until both have started (a sequential run would never get there)", async () => {
    let started = 0;
    const bothStarted = Promise.withResolvers<void>();
    const base = fakes({ [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } });
    const deps: WebhookDeps = {
      ...base,
      budgetMs: 2000,
      agent: (server) => ({
        apps: async () => {
          if (++started === 2) bothStarted.resolve();
          await bothStarted.promise;
          return base.agent(server).apps();
        },
        deploy: base.agent(server).deploy,
      }),
    };
    const { results } = (await (await runOnBoth(deps)).json()) as { results: { outcome: string }[] };
    expect(started).toBe(2);
    expect(results.map((r) => r.outcome)).toEqual(["deployed", "deployed"]);
  });
});

describe("redelivery", () => {
  it("does not deploy again what a delivery already deployed", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    const again = await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    expect(agents[staging].deploys).toHaveLength(1);
    const { results } = (await again.json()) as { results: { outcome: string; deployment_id?: string }[] };
    expect(results.every((r) => r.outcome === "deployed" && r.deployment_id !== undefined)).toBe(true);
  });

  it("evaluates a failed delivery again and replaces its row", async () => {
    const failing = { [staging]: { serving: null, deploys: [], deployError: new AgentError(409, "busy") }, [production]: { serving: null, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(failing));
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "failed" });

    const healthy = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(healthy));
    expect(healthy[staging].deploys).toHaveLength(1);
    expect(healthy[production].deploys).toHaveLength(0); // production had deployed: left alone
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed" });
    expect(db().prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE delivery_id = 'delivery-1' AND server_id = ?").get(staging)).toEqual({ n: 1 });
  });

  it("evaluates a skipped delivery again", async () => {
    const serving = { [staging]: { serving: `x:${SHA}`, deploys: [] }, [production]: { serving: `x:${SHA}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(serving));
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "skipped" });
    const moved = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(moved));
    expect(moved[staging].deploys).toHaveLength(1);
  });
});

describe("concurrency and replays", () => {
  type Results = { results: { server: string; outcome: string; detail: string; deployment_id?: string }[] };

  /** An agent whose deploy takes a moment, so concurrent handlers overlap. */
  function slow(agents: Record<string, FakeAgent>, compare?: WebhookDeps["compare"]): WebhookDeps {
    const base = fakes(agents, compare);
    return { ...base, agent: (server) => ({ ...base.agent(server), deploy: async (app, target) => (await new Promise((r) => setTimeout(r, 25)), base.agent(server).deploy(app, target)) }) };
  }

  it("deploys once when two identical deliveries arrive together, and the record stays deployed", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const deps = slow(agents);
    const [a, b] = await Promise.all([handleGithubWebhook(delivery(runPayload()), deps), handleGithubWebhook(delivery(runPayload()), deps)]);
    expect(agents[staging].deploys).toHaveLength(1);
    expect(agents[production].deploys).toHaveLength(1);
    const outcomes = [...((await a.json()) as Results).results, ...((await b.json()) as Results).results].map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["deployed", "deployed", "pending", "pending"]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed", deploymentId: expect.stringMatching(/^dep-/) });
    expect(db().prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE server_id = ?").get(staging)).toEqual({ n: 1 });
  });

  it("deploys once when a second delivery id carries the same workflow run, together or later", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const deps = slow(agents);
    await Promise.all([handleGithubWebhook(delivery(runPayload(), { id: "first" }), deps), handleGithubWebhook(delivery(runPayload(), { id: "second" }), deps)]);
    expect(agents[staging].deploys).toHaveLength(1);

    const later = (await (await handleGithubWebhook(delivery(runPayload(), { id: "third" }), deps)).json()) as Results;
    expect(agents[staging].deploys).toHaveLength(1);
    expect(later.results.every((r) => r.outcome === "deployed")).toBe(true);
  });

  it("treats another attempt of the run, or another run, as a new event", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload(), { id: "a" }), fakes(agents));
    await handleGithubWebhook(delivery({ ...runPayload(), workflow_run: { ...runPayload().workflow_run, run_attempt: 2 } }, { id: "b" }), fakes(agents));
    await handleGithubWebhook(delivery({ ...runPayload(), workflow_run: { ...runPayload().workflow_run, id: 101 } }, { id: "c" }), fakes(agents));
    expect(agents[staging].deploys).toHaveLength(3);
  });

  it("never lets a later failure replace a deployed record", async () => {
    const healthy = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), fakes(healthy));
    const row = { deliveryId: "delivery-1", repo: "Acme/Shop", branch: "main", sha: SHA, serverId: staging, app: "shop", outcome: "failed" as const, detail: "late", deploymentId: null };
    expect(deliveries.recordDelivery(row)).toMatchObject({ outcome: "deployed", detail: "deployment started" });
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed" });
    // And the agent being down when the delivery is replayed neither deploys nor rewrites the record.
    const down = { [staging]: { serving: null, deploys: [], appsError: new AgentError(0, "cannot reach the agent") }, [production]: { serving: null, deploys: [] } };
    const again = (await (await handleGithubWebhook(delivery(runPayload()), fakes(down))).json()) as Results;
    expect(again.results.map((r) => r.outcome)).toEqual(["deployed", "deployed"]);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed" });
  });

  it("does not let a crashed claim block redelivery forever, but does while it is fresh", async () => {
    const claim = (at: number) =>
      deliveries.claimDelivery({ deliveryId: "delivery-1", repo: "Acme/Shop", branch: "main", sha: SHA, serverId: staging, app: "shop", runKey: "acme/shop#100#1" }, at);
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };

    expect(claim(Date.now()).claimed).toBe(true);
    const blocked = (await (await handleGithubWebhook(delivery(runPayload()), fakes(agents))).json()) as Results;
    expect(blocked.results.find((r) => r.server === "staging")).toMatchObject({ outcome: "pending" });
    expect(agents[staging].deploys).toHaveLength(0);

    db().prepare("UPDATE webhook_deliveries SET at = ?").run(Date.now() - deliveries.PENDING_STALE_MS - 1000);
    await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    expect(agents[staging].deploys).toHaveLength(1);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed" });
  });
});

describe("a deploy request that got no answer", () => {
  type Results = { results: { server: string; outcome: string; detail: string }[] };
  const hang = (agents: Record<string, FakeAgent>, over: Partial<WebhookDeps> = {}): WebhookDeps => {
    const base = fakes(agents);
    return { ...base, deployBudgetMs: 30, agent: (server) => ({ ...base.agent(server), deploy: () => new Promise(() => {}) }), ...over };
  };

  it("is recorded as unknown, shown as such, and not deployed again by a redelivery", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    const first = (await (await handleGithubWebhook(delivery(runPayload()), hang(agents))).json()) as Results;
    expect(first.results.map((r) => r.outcome)).toEqual(["unknown", "unknown"]);
    expect(deliveries.recentDeliveries(staging, "shop")[0]).toMatchObject({ outcome: "unknown" });

    // The app cannot be read: the unknown outcome stands, for the same delivery id and for the same commit under a new id and run.
    const unreadable = { [staging]: { serving: null, deploys: [], appsError: new AgentError(0, "cannot reach the agent") }, [production]: { serving: null, deploys: [], appsError: new AgentError(0, "cannot reach the agent") } };
    const same = (await (await handleGithubWebhook(delivery(runPayload()), fakes(unreadable))).json()) as Results;
    const other = (await (await handleGithubWebhook(delivery({ ...runPayload(), workflow_run: { ...runPayload().workflow_run, id: 777 } }, { id: "other" }), fakes(unreadable))).json()) as Results;
    expect(same.results.map((r) => r.outcome)).toEqual(["unknown", "unknown"]);
    expect(other.results.map((r) => r.outcome)).toEqual(["unknown", "unknown"]);
    expect(unreadable[staging].deploys).toHaveLength(0);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "unknown" });
  });

  it("is settled once the serving ref can be read: serving the commit means skipped, otherwise the redelivery proceeds", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), hang(agents));

    const started = { [staging]: { serving: `x:${SHA}`, deploys: [] }, [production]: { serving: `x:${SHA}`, deploys: [] } };
    const seen = (await (await handleGithubWebhook(delivery(runPayload()), fakes(started))).json()) as Results;
    expect(seen.results.map((r) => r.detail)).toEqual(["already serving", "already serving"]);
    expect(started[staging].deploys).toHaveLength(0);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "skipped" });
  });

  it("proceeds with a redelivery when the app is readable and still serves the old commit", async () => {
    const agents = { [staging]: { serving: `x:${OLD}`, deploys: [] }, [production]: { serving: `x:${OLD}`, deploys: [] } };
    await handleGithubWebhook(delivery(runPayload()), hang(agents));
    await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    expect(agents[staging].deploys).toHaveLength(1);
    expect(deliveries.findDelivery("delivery-1", staging, "shop")).toMatchObject({ outcome: "deployed" });
  });
});

describe("failures in the logging and the secret", () => {
  it("answers a deployment the same when the audit log cannot be written", async () => {
    const agents = { [staging]: { serving: null, deploys: [] }, [production]: { serving: null, deploys: [] } };
    db().exec("ALTER TABLE audit_log RENAME TO audit_log_away");
    let res: Response;
    try {
      res = await handleGithubWebhook(delivery(runPayload()), fakes(agents));
    } finally {
      db().exec("ALTER TABLE audit_log_away RENAME TO audit_log");
    }
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: { outcome: string }[] }).results.map((r) => r.outcome)).toEqual(["deployed", "deployed"]);
    expect(agents[staging].deploys).toHaveLength(1);
  });

  it("says so, not a bare 500, when the stored secret cannot be decrypted", async () => {
    db().prepare("UPDATE integrations SET token_enc = 'not-encrypted' WHERE provider = 'github-webhook'").run();
    const res = await POST(delivery(runPayload()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("webhook secret cannot be read");
  });
});

describe("the deliveries table of an existing database", () => {
  it("keeps its rows when the table gains the new outcomes", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase } = await import("@/lib/db");
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL, at INTEGER NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
        sha TEXT NOT NULL, server_id TEXT NOT NULL, app TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('deployed', 'skipped', 'failed')), detail TEXT NOT NULL, deployment_id TEXT,
        UNIQUE (delivery_id, server_id, app)
      );
      CREATE TABLE app_repos (server_id TEXT NOT NULL, app TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, auto_deploy_workflow TEXT, PRIMARY KEY (server_id, app));
      INSERT INTO webhook_deliveries (delivery_id, at, repo, branch, sha, server_id, app, outcome, detail, deployment_id)
        VALUES ('old-1', 5, 'a/b', 'main', '${SHA}', 's', 'shop', 'deployed', 'deployment started', 'dep-1');
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT);
      -- a later migration adds a column to servers
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY); -- a later migration adds the step-up column to it
      PRAGMA user_version = 5;
    `);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("SELECT delivery_id, outcome, deployment_id, run_key FROM webhook_deliveries").all()).toEqual([
        { delivery_id: "old-1", outcome: "deployed", deployment_id: "dep-1", run_key: null },
      ]);
      for (const outcome of ["pending", "unknown"]) {
        upgraded
          .prepare("INSERT INTO webhook_deliveries (delivery_id, at, repo, branch, sha, server_id, app, outcome, detail) VALUES (?, 1, 'a/b', 'main', 'x', 's', 'shop', ?, '')")
          .run(`new-${outcome}`, outcome);
      }
      expect(() => upgraded.exec("INSERT INTO webhook_deliveries (delivery_id, at, repo, branch, sha, server_id, app, outcome, detail) VALUES ('z', 1, 'a/b', 'main', 'x', 's', 'shop', 'bogus', '')")).toThrow();
    } finally {
      upgraded.close();
    }
  });
});

describe("delivery table", () => {
  it("keeps the newest 500 rows and lists an app's latest first", () => {
    for (let i = 0; i < 510; i++) {
      deliveries.recordDelivery(
        { deliveryId: `d${i}`, repo: "a/b", branch: "main", sha: SHA, serverId: staging, app: "shop", outcome: "skipped", detail: "x", deploymentId: null },
        1000 + i,
      );
    }
    expect(db().prepare("SELECT count(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 500 });
    expect(deliveries.findDelivery("d0", staging, "shop")).toBeNull();
    expect(deliveries.findDelivery("d10", staging, "shop")).not.toBeNull();
    expect(deliveries.recentDeliveries(staging, "shop").map((r) => r.deliveryId)).toEqual(["d509", "d508", "d507", "d506", "d505", "d504", "d503", "d502", "d501", "d500"]);
  });
});

describe("settings storage", () => {
  it("stores the secret encrypted, replaces it on regeneration, and deletes it on removal", () => {
    const raw = JSON.stringify(db().prepare("SELECT * FROM integrations WHERE provider = 'github-webhook'").get());
    expect(raw).not.toContain(secret);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(integrations.webhookSecret()).toBe(secret);
    const next = integrations.regenerateWebhookSecret();
    expect(next).not.toBe(secret);
    expect(integrations.webhookSecret()).toBe(next);
    expect(integrations.webhookSecretSince()).not.toBeNull();
    integrations.removeWebhookSecret();
    expect(integrations.webhookSecret()).toBeNull();
    expect(integrations.webhookSecretSince()).toBeNull();
  });

  it("keeps automatic deploys when the same link is saved again, and turns them off when the source changes", () => {
    integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "main" });
    expect(integrations.getAppRepo(staging, "shop")?.autoDeployWorkflow).toBe("Build and push");
    integrations.setAppRepo(staging, "shop", { repo: "acme/shop", branch: "release" });
    expect(integrations.getAppRepo(staging, "shop")?.autoDeployWorkflow).toBeNull();
  });
});
