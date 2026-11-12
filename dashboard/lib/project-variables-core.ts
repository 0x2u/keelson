import type { AppConfig } from "@/lib/agent-types";
import type { ServerFacts } from "@/lib/project-hub-core";
import { previewParent } from "@/lib/project-apps-core";
import { diffVariables, type Environment, type Placement, type Project, type VariableRow, type VariableState } from "@/lib/projects-core";

// The Variables tab of a project: which app's variables are shown (an environment, then one of its apps when it has several),
// and the comparison of two environments' `env:` read from the facts the hub already holds.

export interface VariablesQuery {
  env?: string;
  /** `<server id>/<app>`, the key of a placement. */
  app?: string;
  a?: string;
  b?: string;
}

export const placementSlot = (p: Placement): string => `${p.server.id}/${p.app.name}`;

/** The apps of an environment whose variables can be managed: preview instances (`<app>-pr-N`) have the preview scope of their parent instead. */
export function managedPlacements(env: Environment): Placement[] {
  const own = env.placements.filter((p) => previewParent(p.app.name) === null);
  return own.length > 0 ? own : env.placements;
}

export interface VariablesTarget {
  /** Every environment that has an app to show, in the project's order. */
  environments: { name: string; placements: Placement[] }[];
  env: { name: string; placements: Placement[] };
  chosen: Placement;
}

/** The environment and app a request asks for; the first of each when absent or unknown (a stale link must still show something). Null when the project has no app to show. */
export function pickVariablesTarget(project: Project, query: Pick<VariablesQuery, "env" | "app">): VariablesTarget | null {
  const environments = project.environments.map((e) => ({ name: e.name, placements: managedPlacements(e) })).filter((e) => e.placements.length > 0);
  const env = environments.find((e) => e.name === query.env) ?? environments[0];
  if (!env) return null;
  const chosen = env.placements.find((p) => placementSlot(p) === query.app) ?? env.placements[0];
  return { environments, env, chosen };
}

/** Where a choice of the tab leads. Defaults are left out of the address. */
export function variablesHref(project: string, choice: { env?: string; app?: string; scope?: "preview"; a?: string; b?: string } = {}): string {
  const q = new URLSearchParams();
  if (choice.env) q.set("env", choice.env);
  if (choice.app) q.set("app", choice.app);
  if (choice.scope) q.set("scope", choice.scope);
  if (choice.a) q.set("a", choice.a);
  if (choice.b) q.set("b", choice.b);
  const qs = q.toString();
  return `/projects/${encodeURIComponent(project)}/variables${qs ? `?${qs}` : ""}`;
}

export interface EnvironmentComparison {
  a: Environment;
  b: Environment;
  /** Why a side could not be read; its variables are then not compared. */
  errorA?: string;
  errorB?: string;
  rows: VariableRow[];
  counts: Partial<Record<VariableState, number>>;
  /** Every pair of environments that can be chosen, once each (x < y by name). */
  pairs: { x: string; y: string }[];
}

function configOf(placement: Placement, facts: ServerFacts[]): { app?: AppConfig; error?: string } {
  const f = facts.find((s) => s.server.id === placement.server.id);
  if (!f) return { error: `${placement.server.name} did not answer` };
  if (f.config === null) return { error: "this agent has no editable configuration, or it could not be read" };
  return { app: f.config.apps?.find((a) => a.name === placement.app.name) };
}

/** The comparison of two environments' `env:`, by default the first two; null when the project has fewer than two. */
export function compareEnvironments(project: Project, facts: ServerFacts[], query: Pick<VariablesQuery, "a" | "b"> = {}): EnvironmentComparison | null {
  const envs = project.environments;
  const a = envs.find((e) => e.name === query.a) ?? envs[0];
  const b = envs.find((e) => e.name === query.b && e.name !== a?.name) ?? envs.find((e) => e.name !== a?.name);
  if (!a || !b) return null;
  const ca = configOf(managedPlacements(a)[0], facts);
  const cb = configOf(managedPlacements(b)[0], facts);
  const rows = !ca.error && !cb.error ? diffVariables(ca.app, cb.app) : [];
  const counts: Partial<Record<VariableState, number>> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const pairs = envs.flatMap((x) => envs.filter((y) => y.name > x.name).map((y) => ({ x: x.name, y: y.name })));
  return { a, b, errorA: ca.error, errorB: cb.error, rows, counts, pairs };
}

/** The summary line under the comparison: what only one side has, and what both do. */
export function comparisonSummary(c: Pick<EnvironmentComparison, "a" | "b" | "counts">): string {
  const both = (c.counts.secret ?? 0) + (c.counts.same ?? 0) + (c.counts.different ?? 0);
  return `${c.counts["only-a"] ?? 0} only in ${c.a.name} · ${c.counts["only-b"] ?? 0} only in ${c.b.name} · ${both} in both`;
}
