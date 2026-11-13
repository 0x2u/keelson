import { describe, expect, it } from "vitest";
import {
  checkApps,
  checkConfigDocument,
  checkConfigValidation,
  checkContainers,
  checkDatabases,
  checkDelivery,
  checkDeployments,
  checkInfo,
  checkJobs,
  checkProjectConfigDocument,
  checkProjects,
  checkProofs,
  checkProxy,
  checkSystem,
  MODEL_SECTIONS,
  type ContractCheck,
} from "@/lib/contract-shapes";
import { golden, goldenNames } from "./golden";

// The runtime guard of lib/contract-shapes.ts, on what a real agent answered (contract/agent) and on that answer after
// the kind of change that breaks the dashboard without a type error: a key renamed, a type changed, a key gone.

/** Every answer of contract/agent and the check of what the dashboard reads in it. A new answer needs its check here. */
const CHECKS: Record<string, ContractCheck> = {
  apps: checkApps,
  config: checkConfigDocument,
  "config-validate": checkConfigValidation,
  "config-validate-invalid": checkConfigValidation,
  containers: checkContainers,
  databases: checkDatabases,
  delivery: checkDelivery,
  deployments: checkDeployments,
  info: checkInfo,
  jobs: checkJobs,
  "project-blog-config": checkProjectConfigDocument,
  projects: checkProjects,
  proofs: checkProofs,
  proxy: checkProxy,
  system: checkSystem,
};

type Json = Record<string, unknown>;

/** The answer with `change` applied to a copy of it. */
function changed<T>(name: string, change: (doc: T) => void): T {
  const doc = golden<T>(name);
  change(doc);
  return doc;
}

/** Renames a key where it stands, keeping its value. */
function rename(o: Json, from: string, to: string): void {
  o[to] = o[from];
  delete o[from];
}

describe("what the real agent answered", () => {
  it("has a check for every answer, and an answer for every check", () => {
    expect(goldenNames()).toEqual(Object.keys(CHECKS).sort());
  });

  it.each(Object.entries(CHECKS))("%s has what the dashboard reads", (name, check) => {
    expect(check(golden(name))).toEqual([]);
  });

  it("is not empty where the dashboard has most to read", () => {
    const apps = golden<{ container: unknown; last_deployment: { phases?: unknown[]; serving_ref?: string } | null }[]>("apps");
    expect(apps.some((a) => a.container !== null)).toBe(true);
    expect(apps.some((a) => a.last_deployment?.phases?.length && a.last_deployment.serving_ref)).toBe(true);
    const databases = golden<{ backup: unknown; managed?: boolean }[]>("databases");
    expect(databases.some((d) => d.backup !== null)).toBe(true);
    expect(databases.some((d) => d.backup === null)).toBe(true);
    expect(databases.some((d) => d.managed)).toBe(true);
    expect(golden<{ kind: string }[]>("jobs").map((j) => j.kind).sort()).toEqual(["backup", "backup", "container", "container", "host", "host", "http"]);
    expect(golden<unknown[]>("deployments").length).toBeGreaterThanOrEqual(2);
    expect(golden<unknown[]>("containers").length).toBeGreaterThanOrEqual(1);
  });
});

describe("the guard sees what drift looks like", () => {
  it("names a key the agent renamed (the model's `backups` back to `backup`)", () => {
    const doc = changed<{ model: { databases: Json[] } }>("config", (d) => rename(d.model.databases[0], "backups", "backup"));
    expect(checkConfigDocument(doc)).toEqual(["config.model.databases[0].backup: a legacy key; the dashboard reads backups"]);
  });

  it("names a key the agent renamed where an answer carries it (the status of a database)", () => {
    const doc = changed<Json[]>("databases", (d) => rename(d[0], "backup", "backups"));
    expect(checkDatabases(doc)).toEqual(["databases[0].backup: missing"]);
  });

  it("names the legacy spellings of an app, a step, a job, a section", () => {
    const doc = changed<{ model: { apps: Json[]; jobs: Json[]; postgres?: unknown } }>("config", (d) => {
      d.model.apps[0].host_ports = [4000];
      d.model.apps[1].ports = ["9000:9000"];
      (d.model.apps[0].release as { steps: Json[] }).steps[2].run = ["/srv/warm.sh"];
      d.model.jobs[0].run = ["/srv/purge.sh"];
      d.model.postgres = {};
    });
    expect(checkConfigDocument(doc)).toEqual([
      "config.model.apps[0].release.steps[2].run: a legacy key; the dashboard reads host",
      "config.model.apps[0].host_ports: a legacy key; the dashboard reads port.host",
      "config.model.apps[1].ports: a legacy key; the dashboard reads publish",
      "config.model.jobs[0].run: a legacy key; the dashboard reads host",
      "config.model.postgres: a legacy key; the dashboard reads managed_postgres",
      "config.model.postgres: a section the dashboard does not know",
    ]);
  });

  it("names a section of the model the dashboard does not know", () => {
    const doc = changed<{ model: Json }>("config", (d) => (d.model.telemetry = {}));
    expect(checkConfigDocument(doc)).toEqual([`config.model.telemetry: a section the dashboard does not know`]);
    expect(MODEL_SECTIONS).toContain("managed_postgres");
  });

  it("names a key that is gone, and one that changed its type", () => {
    const system = changed<{ build: { limits: Json } }>("system", (d) => delete d.build.limits.max_source);
    expect(checkSystem(system)).toEqual(["system.build.limits.max_source: missing"]);
    const deployments = changed<Json[]>("deployments", (d) => (d[0].serving_ref = 7));
    expect(checkDeployments(deployments)).toEqual(["deployments[0].serving_ref: expected a string, got a number"]);
  });

  it("names a phase or a status it cannot place", () => {
    const deployments = changed<{ phases: Json[] }[]>("deployments", (d) => {
      d[1].phases[0].name = "deploy";
      Object.assign(d[1], { status: "done" });
    });
    expect(checkDeployments(deployments)).toEqual([
      'deployments[1].status: expected one of running, succeeded, failed, rolled_back, rollback_failed, got "done"',
      'deployments[1].phases[0].name: expected one of source, build, release, switch, soak, live, got "deploy"',
    ]);
  });

  it("names an answer that is not the kind of thing the route returns", () => {
    expect(checkApps({ error: "x" })).toEqual(["apps: expected an array, got an object"]);
    expect(checkSystem(null)).toEqual(["system: expected an object, got null"]);
  });
});
