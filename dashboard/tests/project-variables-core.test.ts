import { describe, expect, it } from "vitest";
import type { AppStatus, ConfigModel } from "@/lib/agent-types";
import { HIDDEN } from "@/lib/agent-types";
import type { ServerFacts } from "@/lib/project-hub-core";
import { pickSourceApp, sourceChoices, sourceHref } from "@/lib/project-source-core";
import { compareEnvironments, comparisonSummary, pickVariablesTarget, variablesHref } from "@/lib/project-variables-core";
import { groupProjects, type Placement, type ServerRef } from "@/lib/projects-core";

const s1: ServerRef = { id: "s1", name: "alpha", canDeploy: true };
const s2: ServerRef = { id: "s2", name: "beta", canDeploy: false };
const app = (name: string, environment = "", project = "shop"): AppStatus => ({ name, image: "x", project, environment, digest: "", container: null, last_deployment: null }) as AppStatus;
const place = (a: AppStatus, server = s1): Placement => ({ server, app: a, jobs: [] });
const project = groupProjects([place(app("shop")), place(app("shop-pr-4")), place(app("shop-staging", "staging"), s2), place(app("shop-api", ""))])[0];
const model = (apps: Record<string, Record<string, string>>): ConfigModel => ({ apps: Object.entries(apps).map(([name, env]) => ({ name, env })) }) as ConfigModel;
const facts = (server: ServerRef, config: ConfigModel | null): ServerFacts => ({ server, apps: [], jobs: [], databases: [], config });

describe("pickVariablesTarget", () => {
  it("defaults to the first environment and its first app, and leaves preview instances out", () => {
    const t = pickVariablesTarget(project, {});
    expect(t?.environments.map((e) => e.name)).toEqual(["production", "staging"]);
    expect(t?.env.placements.map((p) => p.app.name)).toEqual(["shop", "shop-api"]);
    expect(t?.chosen.app.name).toBe("shop");
  });
  it("follows the environment and the app asked for, and falls back on a stale link", () => {
    expect(pickVariablesTarget(project, { env: "staging" })?.chosen.app.name).toBe("shop-staging");
    expect(pickVariablesTarget(project, { env: "production", app: "s1/shop-api" })?.chosen.app.name).toBe("shop-api");
    expect(pickVariablesTarget(project, { env: "gone", app: "s9/none" })?.chosen.app.name).toBe("shop");
  });
  it("is null for a project with no environment", () => {
    expect(pickVariablesTarget({ name: "x", environments: [] }, {})).toBeNull();
  });
});

describe("variablesHref", () => {
  it("leaves the defaults out and encodes the rest", () => {
    expect(variablesHref("shop")).toBe("/projects/shop/variables");
    expect(variablesHref("my shop", { env: "staging", app: "s2/shop-staging", scope: "preview" })).toBe("/projects/my%20shop/variables?env=staging&app=s2%2Fshop-staging&scope=preview");
  });
});

describe("compareEnvironments", () => {
  const f = [facts(s1, model({ shop: { A: "1", B: "2", S: HIDDEN } })), facts(s2, model({ "shop-staging": { A: "1", B: "3", S: HIDDEN, C: "x" } }))];
  it("compares the env of the first apps of the first two environments", () => {
    const c = compareEnvironments(project, f);
    expect(c?.a.name).toBe("production");
    expect(c?.b.name).toBe("staging");
    expect(c?.rows.map((r) => [r.key, r.state])).toEqual([["A", "same"], ["B", "different"], ["C", "only-b"], ["S", "secret"]]);
    expect(comparisonSummary(c!)).toBe("0 only in production · 1 only in staging · 3 in both");
    expect(c?.pairs).toEqual([{ x: "production", y: "staging" }]);
  });
  it("does not compare a side it could not read, and says why", () => {
    const c = compareEnvironments(project, [f[0]]);
    expect(c?.rows).toEqual([]);
    expect(c?.errorB).toBe("beta did not answer");
    const old = compareEnvironments(project, [f[0], facts(s2, null)]);
    expect(old?.errorB).toContain("no editable configuration");
  });
  it("is null with a single environment", () => {
    const one = groupProjects([place(app("solo", "", "solo"))])[0];
    expect(compareEnvironments(one, [])).toBeNull();
  });
});

describe("source choices", () => {
  it("lists the apps of every environment, the primary first, without previews", () => {
    expect(sourceChoices(project).map((c) => [c.environment, c.placement.app.name])).toEqual([["production", "shop"], ["production", "shop-api"], ["staging", "shop-staging"]]);
  });
  it("picks the app asked for, else the primary", () => {
    expect(pickSourceApp(project, "s2/shop-staging")?.chosen.placement.app.name).toBe("shop-staging");
    expect(pickSourceApp(project, "nope")?.chosen.placement.app.name).toBe("shop");
    expect(pickSourceApp({ name: "x", environments: [] }, undefined)).toBeNull();
  });
  it("links the primary without a query", () => {
    expect(sourceHref("shop")).toBe("/projects/shop/source");
    expect(sourceHref("shop", "s2/shop-staging")).toBe("/projects/shop/source?app=s2%2Fshop-staging");
  });
});
