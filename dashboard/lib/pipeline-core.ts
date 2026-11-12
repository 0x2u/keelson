import type { Deployment, DeploymentPhase, PhaseName } from "@/lib/agent-types";
import { duration } from "@/lib/format";
import { versionOf } from "@/lib/image-ref-core";
import { deployVerb } from "@/lib/labels-core";
import { PIPELINE_STEPS, type StatusView } from "@/lib/status";

// The pipeline of a deployment: Source, Build, Release, Switch, Soak, Live. The agent reports the phases a deployment
// reached (or skipped on purpose); this turns them into the steps a page draws. Pure: components only render it.

/** The pipeline order. */
export const PHASE_ORDER: readonly PhaseName[] = ["source", "build", "release", "switch", "soak", "live"];

const LABELS: Record<PhaseName, string> = { source: "Source", build: "Build", release: "Release", switch: "Switch", soak: "Soak", live: "Live" };

export const phaseLabel = (name: PhaseName): string => LABELS[name];

export type StepState = keyof typeof PIPELINE_STEPS;

export interface PipelineStep {
  name: PhaseName;
  label: string;
  state: StepState;
  view: StatusView;
  startedAt?: string;
  finishedAt?: string;
}

export interface Pipeline {
  steps: PipelineStep[];
  /** The step that failed, if one did. */
  failed: PipelineStep | null;
  /** The step in progress, if one is. */
  running: PipelineStep | null;
}

/** What a pipeline is drawn from: a deployment as the agent lists it. */
export type PipelineSource = Pick<Deployment, "status" | "trigger" | "phases">;

const index = (name: PhaseName): number => PHASE_ORDER.indexOf(name);

function reported(phases: DeploymentPhase[] | undefined): DeploymentPhase[] {
  const seen = new Map<PhaseName, DeploymentPhase>();
  for (const p of phases ?? []) if (index(p.name) >= 0) seen.set(p.name, p);
  return [...seen.values()].sort((a, b) => index(a.name) - index(b.name));
}

function step(name: PhaseName, state: StepState, p?: DeploymentPhase): PipelineStep {
  return { name, label: LABELS[name], state, view: PIPELINE_STEPS[state], ...(p ? { startedAt: p.started_at, ...(p.finished_at ? { finishedAt: p.finished_at } : {}) } : {}) };
}

const STATE_OF: Record<DeploymentPhase["status"], StepState> = { running: "running", done: "done", failed: "failed", skipped: "skipped" };

/**
 * The steps of a deployment, or null when the agent does not report phases (an older agent, or a record from before it
 * did): the page then shows what it always showed. Rules, the same on every page:
 * - a phase the agent reported is drawn as reported, in pipeline order;
 * - Source and Build that were never reported are left out (a plain image deploy has none), except for a deployment that
 *   was built on another server, where they are drawn as "Built on another server";
 * - after the last reported phase: "Not started" while the deployment runs, "Not reached" when it ended before them, and
 *   nothing when it succeeded (a phase that does not apply, such as the soak of an in-place app, is simply absent).
 */
export function pipeline(d: PipelineSource): Pipeline | null {
  const done = reported(d.phases);
  if (done.length === 0) return null;
  const byName = new Map(done.map((p) => [p.name, p]));
  const first = index(done[0].name);
  const last = index(done[done.length - 1].name);
  const steps: PipelineStep[] = [];
  PHASE_ORDER.forEach((name, i) => {
    const p = byName.get(name);
    if (p) steps.push(step(name, STATE_OF[p.status], p));
    else if (i < first) {
      if (d.trigger === "transfer" && (name === "source" || name === "build")) steps.push(step(name, "elsewhere"));
    } else if (i > last) {
      if (d.status === "running") steps.push(step(name, "pending"));
      else if (d.status !== "succeeded") steps.push(step(name, "notReached"));
    }
  });
  return { steps, failed: steps.find((s) => s.state === "failed") ?? null, running: steps.find((s) => s.state === "running") ?? null };
}

/** How long a step took (or has been running, at `now`); null for a step that has not started, never will or was skipped. */
export function stepDuration(s: PipelineStep, now?: number): string | null {
  if (s.startedAt === undefined || s.state === "skipped") return null;
  if (s.finishedAt !== undefined) return duration(s.startedAt, s.finishedAt);
  return s.state === "running" && now !== undefined ? duration(s.startedAt, undefined, now) : null;
}

/** The title of the notice of a deployment that did not work, with the phase it failed in; null for one that did. */
export function failureTitle(d: PipelineSource): string | null {
  if (d.status === "running" || d.status === "succeeded") return null;
  const verb = deployVerb(d.trigger);
  const failed = pipeline(d)?.failed;
  const where = failed ? ` in ${failed.label}` : "";
  if (d.status === "rolled_back") return `${verb} failed${where} and was rolled back`;
  if (d.status === "rollback_failed") return `${verb} failed${where} and the previous version could not be restored`;
  return `${verb} failed${where}`;
}

/**
 * What still serves after a deployment that did not work, in one sentence; null while it runs, after a success, or when
 * the agent says nothing about it (an older agent): then nothing is claimed.
 */
export function servingSentence(d: Pick<Deployment, "status" | "serving_ref" | "phases">): string | null {
  const named = d.serving_ref ? ` (${versionOf(d.serving_ref)})` : "";
  switch (d.status) {
    case "failed":
      if (d.serving_ref) return `The previous version${named} is still serving.`;
      return d.phases === undefined ? null : "Nothing is serving.";
    case "rolled_back":
      return `The previous version${named} is serving again.`;
    case "rollback_failed":
      return "The previous version could not be restored: nothing is known to be serving.";
    default:
      return null;
  }
}
