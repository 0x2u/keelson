import type { AppConfig, AppStatus, JobStatus } from "@/lib/agent-types";
import { HIDDEN } from "@/lib/agent-types";
import { healthFromStatus } from "@/lib/format";
import { splitRef } from "@/lib/image-ref-core";
import { containerStatus, ENVIRONMENTS, PLACEMENTS, type StatusView, type Tone } from "@/lib/status";

// A project is what the operator calls the thing they ship ("shop"); an environment is one running copy of it
// ("production", "staging"), possibly on another server. The agent only carries two labels per app; everything else is
// derived here, in one place.

export const DEFAULT_ENVIRONMENT = "production";

export interface ServerRef {
  id: string;
  name: string;
  /** The server holds a deploy secret: it can be deployed to. */
  canDeploy: boolean;
  /** The address the server's published ports answer on (its public address, else the host of its agent URL); null when not known. Absent where it was not read. */
  host?: string | null;
}

/** One app on one server, with the jobs that run in it. */
export interface Placement {
  server: ServerRef;
  app: AppStatus;
  jobs: JobStatus[];
}

export interface Environment {
  name: string;
  placements: Placement[];
}

export interface Project {
  name: string;
  environments: Environment[];
}

export const projectOf = (a: Pick<AppStatus, "name" | "project">): string => a.project || a.name;
export const environmentOf = (a: Pick<AppStatus, "environment">): string => a.environment || DEFAULT_ENVIRONMENT;

/** production first, then staging, then the others by name: the order people read them in. */
const ORDER = [DEFAULT_ENVIRONMENT, "staging"];
function byEnvironment(a: string, b: string): number {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  return a.localeCompare(b);
}

/** Groups apps from every server into projects and their environments. */
export function groupProjects(placements: Placement[]): Project[] {
  const projects = new Map<string, Map<string, Placement[]>>();
  for (const p of placements) {
    const envs = projects.get(projectOf(p.app)) ?? new Map<string, Placement[]>();
    projects.set(projectOf(p.app), envs);
    const list = envs.get(environmentOf(p.app)) ?? [];
    list.push(p);
    envs.set(environmentOf(p.app), list);
  }
  const byPlace = (a: Placement, b: Placement) => a.server.name.localeCompare(b.server.name) || a.app.name.localeCompare(b.app.name);
  return [...projects.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, envs]) => ({
      name,
      environments: [...envs.entries()].sort(([a], [b]) => byEnvironment(a, b)).map(([env, list]) => ({ name: env, placements: list.sort(byPlace) })),
    }));
}

/** The jobs that act on an app: a job that runs a command in the app's container. */
export function jobsOf(app: string, jobs: JobStatus[]): JobStatus[] {
  return jobs.filter((j) => j.kind === "container" && j.target === `container of ${app}`);
}

export interface Health {
  tone: Tone;
  label: string;
}

/** What to show for an app's container: the container vocabulary (Running, Healthy, Starting, Unhealthy, Restarting, Stopped...) or Not deployed. */
export function placementHealth(app: AppStatus): Health {
  const c = app.container;
  if (!c) return PLACEMENTS.notDeployed;
  const state = c.state.restarting ? "restarting" : c.state.running ? "running" : c.state.status;
  const { tone, label } = containerStatus(state, c.state.health ?? healthFromStatus(c.state.status));
  return { tone, label };
}

/** A failed attempt: the version before it, if one ran, is still what serves (or nothing is, when the rollback failed too). */
const FAILED_DEPLOYMENT = ["failed", "rolled_back", "rollback_failed"];

export interface EnvironmentState extends StatusView {
  /** The last deployment failed: shown beside "Running" as a warning, since what serves is an older version. */
  lastFailed: boolean;
  /** Why the container is not fine ("Stopped", "Unhealthy", "Restarting"), when it is not. */
  detail?: string;
}

/**
 * Where an environment stands, in one word (the table is ENVIRONMENTS in lib/status): Deploying while a deployment runs,
 * Running while the container serves (with `lastFailed` and a warning when the newest deployment did not work), Starting
 * while the container is coming up, Down when the container is stopped or unwell or its last deployment succeeded yet
 * nothing runs, Error when the last deployment failed and nothing runs, Not deployed before the first deployment.
 */
export function environmentState(app: AppStatus): EnvironmentState {
  const last = app.last_deployment;
  const lastFailed = last !== null && FAILED_DEPLOYMENT.includes(last.status);
  if (last?.status === "running") return { ...ENVIRONMENTS.deploying, lastFailed: false };
  if (!app.container) {
    if (last === null) return { ...ENVIRONMENTS.notDeployed, lastFailed: false };
    return lastFailed ? { ...ENVIRONMENTS.error, lastFailed } : { ...ENVIRONMENTS.down, lastFailed, detail: "Nothing is running" };
  }
  const health = placementHealth(app);
  if (health.tone === "danger" || !app.container.state.running) return { ...ENVIRONMENTS.down, lastFailed, detail: health.label };
  if (health.tone === "info") return { ...ENVIRONMENTS.starting, lastFailed, detail: health.label };
  return { ...(lastFailed ? ENVIRONMENTS.runningLastFailed : ENVIRONMENTS.running), lastFailed };
}

/** The next scheduled run among the jobs, if any. */
export function nextJob(jobs: JobStatus[]): { name: string; at: string } | null {
  let best: { name: string; at: string } | null = null;
  for (const j of jobs) {
    if (j.paused || !j.next_run) continue;
    if (!best || j.next_run < best.at) best = { name: j.name, at: j.next_run };
  }
  return best;
}

export type Promotion =
  | { ok: true; digest: string; from: Placement; to: Placement }
  | { ok: false; reason: string };

/**
 * Whether the version serving in one environment can be deployed to another, and what exactly: the digest, never a tag,
 * so that what was tested is what ships. A digest names an image of one repository, so both apps must use the same one.
 */
export function planPromotion(from: Placement, to: Placement): Promotion {
  if (from.server.id === to.server.id && from.app.name === to.app.name) return { ok: false, reason: "That is the same app." };
  if (!to.server.canDeploy) return { ok: false, reason: `${to.server.name} has no deploy secret in this dashboard: it cannot deploy.` };
  if (!from.app.container) return { ok: false, reason: `Nothing is running in ${environmentOf(from.app)} to promote.` };
  if (!from.app.digest) return { ok: false, reason: `The image serving in ${environmentOf(from.app)} has no registry digest (it was built locally?), so there is no exact version to promote.` };
  if (from.app.image !== to.app.image) return { ok: false, reason: `The two apps use different images (${from.app.image} and ${to.app.image}): a digest only names an image of one repository.` };
  return { ok: true, digest: from.app.digest, from, to };
}

/** "sha256:" dropped and the first characters kept: enough to tell two versions apart at a glance. */
export const shortDigest = (digest: string): string => (digest ? digest.replace("sha256:", "").slice(0, 12) : "");

/** What an app serves, as a person names it: the tag, else the short digest; null when nothing runs. */
export function servingVersion(app: AppStatus): string | null {
  if (!app.container) return null;
  const { tag, digest } = splitRef(app.container.image);
  return tag ?? (shortDigest(app.digest) || digest || "latest");
}

export interface PromotionView {
  /** The target is production: the one direction that changes what users see. */
  intoProduction: boolean;
  /** What the source serves now, and what the target serves now (null when nothing runs there). */
  from: string | null;
  to: string | null;
  /** The digest that would be deployed, short. */
  digest: string;
  /** The target already runs this very image. */
  same: boolean;
}

/** What the promote dialog shows: the direction, the version production (or the target) runs now, and the one it will run. */
export function promotionView(from: Placement, to: Placement): PromotionView {
  return {
    intoProduction: environmentOf(to.app) === DEFAULT_ENVIRONMENT && environmentOf(from.app) !== DEFAULT_ENVIRONMENT,
    from: servingVersion(from.app),
    to: servingVersion(to.app),
    digest: shortDigest(from.app.digest),
    same: sameVersion(from, to),
  };
}

/** True when two placements run the very same image. */
export function sameVersion(a: Placement, b: Placement): boolean {
  return a.app.digest !== "" && a.app.digest === b.app.digest;
}

export type VariableState = "same" | "different" | "only-a" | "only-b" | "secret";

export interface VariableRow {
  key: string;
  state: VariableState;
  a?: string;
  b?: string;
}

/**
 * What a cell of the variables table says for one side of a row: the value, "hidden" for a secret (the agent never sends
 * it), "(empty)" for an empty string, and "not set" only when that environment does not define the variable at all.
 */
export function variableCell(value: string | undefined): string {
  if (value === undefined) return "not set";
  return value === HIDDEN ? "hidden" : value === "" ? "(empty)" : value;
}

/**
 * Compares the `env` of two apps. A value the agent hides (a secret) cannot be compared: it is reported as a secret present
 * on both sides, or on one. The env_file is not read, only named: what it holds is on the server, not here.
 */
export function diffVariables(a: AppConfig | undefined, b: AppConfig | undefined): VariableRow[] {
  const ea = a?.env ?? {};
  const eb = b?.env ?? {};
  const keys = [...new Set([...Object.keys(ea), ...Object.keys(eb)])].sort();
  return keys.map((key): VariableRow => {
    const inA = key in ea;
    const inB = key in eb;
    if (inA && !inB) return { key, state: "only-a", a: ea[key] };
    if (!inA && inB) return { key, state: "only-b", b: eb[key] };
    if (ea[key] === HIDDEN || eb[key] === HIDDEN) return { key, state: "secret", a: ea[key], b: eb[key] };
    return { key, state: ea[key] === eb[key] ? "same" : "different", a: ea[key], b: eb[key] };
  });
}
