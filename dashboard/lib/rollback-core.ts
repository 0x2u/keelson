import type { Deployment } from "@/lib/agent-types";
import { deployInput, versionOf } from "@/lib/image-ref-core";

/** How many successful deployments the agent looks through to find a rollback target (store.Succeeded(app, 50)). */
export const AGENT_ROLLBACK_WINDOW = 50;

const byNewest = (a: Deployment, b: Deployment): number => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0);

/** Successful deployments, newest first. Ties keep their given order (the agent lists newest first). */
function succeeded(history: Deployment[]): Deployment[] {
  return history
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.status === "succeeded")
    .sort((a, b) => byNewest(a.d, b.d) || a.i - b.i)
    .map(({ d }) => d);
}

export type RollbackPlan =
  | { ok: true; current: string; target: Deployment }
  | { ok: false; current: string; reason: string };

/**
 * What a rollback would deploy, by the agent's own rule (deploy.Rollback): the newest successful deployment whose ref is
 * not the one serving now. `current` is the image of the container that serves, "" when none does. Refs are compared
 * as written: a digest and the tag of the same image count as different, as they do for the agent.
 */
export function rollbackPlan(history: Deployment[], current: string): RollbackPlan {
  const target = succeeded(history).find((d) => d.ref !== current);
  if (target) return { ok: true, current, target };
  const any = succeeded(history).length > 0;
  return {
    ok: false,
    current,
    reason: any
      ? "Every earlier successful deployment ran the image that serves now: there is no other version to go back to."
      : "No deployment of this app has succeeded yet: there is no earlier version to go back to.",
  };
}

export interface RecentVersion {
  ref: string;
  /** When it was last deployed successfully. */
  at: string;
  /** It is the one serving now. */
  serving: boolean;
}

/** The versions deployed successfully before, newest first, each once, for one-click deploys of a version again. The serving one is marked. */
export function recentVersions(history: Deployment[], current: string, limit = 6): RecentVersion[] {
  const seen = new Set<string>();
  const out: RecentVersion[] = [];
  for (const d of succeeded(history)) {
    if (seen.has(d.ref)) continue;
    seen.add(d.ref);
    out.push({ ref: d.ref, at: d.started_at, serving: d.ref === current });
    if (out.length === limit) break;
  }
  return out;
}

export interface DeployChange {
  /** The version serving now (tag or short digest); empty when nothing runs. */
  from: string;
  /** The version the typed text deploys. */
  to: string;
  /** The text names the version that already serves: deploying it replaces the container with a fresh copy. */
  same: boolean;
}

/** What the deploy dialog says will change: from the serving image to the tag or digest typed. */
export function deployChange(current: string, input: string): DeployChange {
  const typed = input.trim();
  const to = typed.startsWith("sha256:") ? typed.slice("sha256:".length, "sha256:".length + 12) : typed;
  return { from: current === "" ? "" : versionOf(current), to, same: current !== "" && deployInput(current) === typed };
}
