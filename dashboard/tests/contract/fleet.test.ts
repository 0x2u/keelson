import { describe, expect, it } from "vitest";
import type { AgentInfo, AppStatus, ConfigDocument, Container, DatabaseStatus, Deployment, JobStatus, Proof, ProxyView, SystemInfo } from "@/lib/agent-types";
import { attentionItems, snapshotFrom, summarize } from "@/lib/attention-core";
import { databaseRows } from "@/lib/databases-fleet-core";
import { headline, placementsOf, recentEvents } from "@/lib/home-core";
import { failureTitle, pipeline, servingSentence } from "@/lib/pipeline-core";
import { projectDots } from "@/lib/project-dot-core";
import { groupProjects, environmentState, servingVersion } from "@/lib/projects-core";
import { configAnswer, serverReadiness } from "@/lib/readiness-core";
import { statsFromSystem } from "@/lib/server-stats-core";
import { checkDatabases } from "@/lib/contract-shapes";
import { golden } from "./golden";

// The cores that judge a fleet (attention, databases, readiness, projects, stats, pipelines), fed with what a real agent
// answered (contract/agent) instead of what a test made up: a key the agent no longer sends makes these say something
// else, or nothing. Times in the answers are all 2026-01-01T00:00:00Z: `now` is that instant.

const NOW = Date.parse("2026-01-01T00:00:00Z");
const server = { id: "s1", name: "contract" };

const info = golden<AgentInfo>("info");
const system = golden<SystemInfo>("system");
const containers = golden<Container[]>("containers");
const apps = golden<AppStatus[]>("apps");
const jobs = golden<JobStatus[]>("jobs");
const databases = golden<DatabaseStatus[]>("databases");
const proxy = golden<ProxyView>("proxy");
const deployments = golden<Deployment[]>("deployments");
const proofs = golden<Proof[]>("proofs");
const config = golden<ConfigDocument>("config");

const snapshot = snapshotFrom(
  server,
  { info: { data: info }, system: { data: system }, containers: { data: containers }, apps: { data: apps }, jobs: { data: jobs }, databases: { data: databases }, proxy: { data: proxy } },
  NOW,
);

describe("the attention model, on a real agent's answers", () => {
  const items = attentionItems([snapshot], NOW);

  it("sees the snapshot as the answers of a reachable server", () => {
    expect(snapshot.reachable).toBe(true);
    expect(snapshot.errors).toBeUndefined();
    expect(snapshot.apps).toHaveLength(9);
    expect(snapshot.databases).toHaveLength(4);
  });

  it("reports the deployment that failed, with the agent's own words, and nothing worse", () => {
    const deployment = items.filter((i) => i.kind === "deployment");
    expect(deployment).toHaveLength(1);
    expect(deployment[0]).toMatchObject({ severity: "warning", subject: "worker", server });
    expect(deployment[0].message).toMatch(/^Deploy of worker missing failed: .*manifest unknown/);
    expect(deployment[0].actions.map((a) => a.href)).toEqual([expect.stringMatching(/^\/servers\/s1\/deployments\/.+/), "/servers/s1/containers/worker"]);
    expect(items.some((i) => i.severity === "critical")).toBe(false);
  });

  it("reports the proxy the agent could not read, with the reason the agent gave", () => {
    const [item] = items.filter((i) => i.kind === "proxy");
    expect(item.message).toBe(`The proxy could not be read: ${proxy.live_error}`);
  });

  it("says what was never deployed, and not what runs", () => {
    const never = items.filter((i) => i.kind === "app-down").map((i) => i.subject);
    expect(never).toEqual(["api", "blog", "docs", "legacy", "shop", "site", "tools", "web"]);
    expect(items.filter((i) => i.kind === "app-down").every((i) => i.severity === "info")).toBe(true);
  });

  it("waits quietly for the first backup of the databases that have one scheduled, and has nothing to say of those that have none", () => {
    expect(items.filter((i) => i.kind === "backup").map((i) => [i.subject, i.message])).toEqual([]);
  });

  it("gives the verdict and the headline of the home page", () => {
    expect(summarize(items)).toEqual({ tone: "warning", label: `${items.length} things need attention`, count: items.length });
    expect(headline(items, [snapshot])).toMatchObject({ tone: "warning", reachable: 1, total: 1 });
  });
});

describe("the databases page, on a real agent's databases", () => {
  it("lists the ones with no backup first, then the ones waiting for their first", () => {
    const { rows, unanswered } = databaseRows([snapshot], NOW);
    expect(unanswered).toEqual([]);
    expect(rows.map((r) => [r.database.name, r.state])).toEqual([
      ["blog", "not-configured"],
      ["native", "not-configured"],
      ["ledger", "first-pending"],
      ["shop", "first-pending"],
    ]);
    expect(rows.find((r) => r.database.name === "shop")?.database).toMatchObject({ managed: true, app: "shop", env_key: "DATABASE_URL", project: "shop" });
  });

  it("reads the last run of a backup the way the agent spells it", () => {
    const withRun = structuredClone(databases);
    const backup = withRun.find((d) => d.name === "ledger")?.backup;
    if (!backup) throw new Error("the captured ledger database has no backup");
    backup.last_run = { id: "r1", status: "failed", started_at: "2025-12-31T00:00:00Z", finished_at: "2025-12-31T00:01:00Z", detail: "no space left" };
    expect(checkDatabases(withRun)).toEqual([]);
    const { rows } = databaseRows([{ ...snapshot, databases: withRun }], NOW);
    expect(rows[0]).toMatchObject({ state: "failed", database: { name: "ledger" } });
    expect(rows[0].detail).toMatch(/no space left/);
  });
});

describe("the readiness checklist, on a real agent's answers", () => {
  const items = serverReadiness(
    {
      server,
      reachable: true,
      version: info.version,
      bundledVersion: null,
      apps,
      databases,
      config: configAnswer({ data: config }),
      proofs: { kind: "ok", value: proofs },
      restoreTests: Object.fromEntries(databases.map((d) => [d.name, { kind: "ok" as const, value: [] }])),
      histories: Object.fromEntries(apps.map((a) => [a.name, { kind: "ok" as const, value: deployments.filter((d) => d.app === a.name) }])),
    },
    NOW,
  );
  const state = (check: string, subject: string) => items.find((i) => i.check === check && i.subject === subject);

  it("finds where the backups of a configured database go in the configuration's model", () => {
    expect(state("offsite", "ledger")).toMatchObject({ state: "ok", detail: "A copy goes to s3.eu-west-3.amazonaws.com/acme-backups." });
  });

  it("asks for a backup where there is none, and for the first one where it is scheduled", () => {
    expect(state("backup", "native")).toMatchObject({ state: "todo", detail: "No backup is configured for this database." });
    expect(state("backup", "ledger")).toMatchObject({ state: "todo", detail: "The first backup is scheduled and has not run yet." });
  });

  it("reads the health path of an app, and whether it was ever deployed", () => {
    expect(state("health", "shop")).toMatchObject({ state: "ok", detail: "A new version is checked with GET /healthz before it takes traffic." });
    expect(state("rollback", "shop")).toMatchObject({ state: "na" });
  });

  it("reads the notification channels of the configuration", () => {
    expect(state("alert", "contract")?.detail).toMatch(/webhook and Telegram/);
  });
});

describe("the projects and the stats of a server, on a real agent's answers", () => {
  it("draws a dot for each project, the app that runs among those that never did", () => {
    const dots = projectDots([snapshot]);
    expect(dots.map((d) => d.name)).toEqual(["api", "blog", "docs", "legacy", "shop", "site", "tools", "web", "worker"]);
    expect(dots.filter((d) => d.label === "Not deployed")).toHaveLength(8);
    expect(dots.find((d) => d.name === "worker")?.label).toBe("Running");
  });

  it("groups the apps into projects and environments from the labels the agent reports", () => {
    const placements = placementsOf([{ ...snapshot, canDeploy: true, deployments }]);
    const projects = groupProjects(placements);
    expect(projects.map((p) => p.name)).toEqual(["api", "blog", "docs", "legacy", "shop", "site", "tools", "web", "worker"]);
    const blog = projects.find((p) => p.name === "blog");
    expect(blog?.environments.map((e) => e.name)).toEqual(["staging"]);
    expect(projects.find((p) => p.name === "shop")?.environments.map((e) => e.name)).toEqual(["production"]);
  });

  it("lists the deployments of the last day as events", () => {
    const events = recentEvents([{ ...snapshot, canDeploy: true, deployments }], NOW);
    expect(events.map((e) => [e.subject, e.status, e.trigger, e.image])).toEqual([
      ["worker", "failed", "api", "ghcr.io/acme/worker:missing"],
      ["worker", "succeeded", "api", "ghcr.io/acme/worker:latest"],
    ]);
    expect(events[0].detail).toMatch(/manifest unknown/);
  });

  it("knows what runs: its state, the version it serves", () => {
    const worker = apps.find((a) => a.name === "worker");
    if (!worker) throw new Error("the captured apps have no worker");
    expect(environmentState(worker)).toMatchObject({ label: "Running", lastFailed: true });
    expect(servingVersion(worker)).toBe("latest");
  });

  it("reads the machine from /v1/system", () => {
    expect(statsFromSystem(system)).toEqual({
      online: true,
      cpus: 4,
      load1: 0.1,
      memTotal: 8 * 1024 ** 3,
      memAvailable: 4 * 1024 ** 3,
      diskTotal: 100_000_000_000,
      diskFree: 40_000_000_000,
      os: "linux",
      arch: "amd64",
      build: system.build?.limits,
    });
    expect(system.build?.limits).toMatchObject({ memory: 4 * 1024 ** 3, cpus: 4, host_network: true, source_hosts: ["api.github.com", "codeload.github.com"] });
  });
});

describe("the pipeline of a deployment, on what a real agent recorded", () => {
  const [failed, succeeded] = deployments;

  it("draws a deployment that failed in its release, with what is still serving", () => {
    expect(failed.status).toBe("failed");
    expect(pipeline(failed)?.steps.map((s) => [s.name, s.state])).toEqual([
      ["release", "failed"],
      ["switch", "notReached"],
      ["soak", "notReached"],
      ["live", "notReached"],
    ]);
    expect(pipeline(failed)?.failed?.name).toBe("release");
    expect(failureTitle(failed)).toMatch(/failed in Release$/);
    expect(failed.serving_ref).toBe("ghcr.io/acme/worker:latest");
    expect(servingSentence(failed)).toBe("The previous version (latest) is still serving.");
  });

  it("draws one that succeeded as the phases it reached", () => {
    expect(pipeline(succeeded)?.steps.map((s) => [s.name, s.state])).toEqual([
      ["release", "done"],
      ["switch", "done"],
      ["live", "done"],
    ]);
    expect(failureTitle(succeeded)).toBeNull();
    expect(servingSentence(succeeded)).toBeNull();
    expect(succeeded.serving_ref).toBe("ghcr.io/acme/worker:latest");
  });

  it("is what the apps list calls the last deployment of the app", () => {
    expect(apps.find((a) => a.name === "worker")?.last_deployment).toEqual(failed);
  });
});
