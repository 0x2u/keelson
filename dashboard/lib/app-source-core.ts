import type { RunState, WorkflowRun } from "@/lib/github-core";

/** Only links that go to GitHub are rendered as links: the address comes from an API answer. */
export function githubUrl(url: string): string | null {
  return url.startsWith("https://github.com/") ? url : null;
}

/** Why a commit cannot be deployed as an image from here; null when it can. */
export function deployBlock(args: { canDeploy: boolean; deploying: boolean; serving: boolean; ci: RunState | null }): string | null {
  if (!args.canDeploy) return "This server is read-only here: it has no deploy secret in the dashboard.";
  if (args.deploying) return "A deployment is running. Wait for it to finish.";
  if (args.serving) return "This commit is already serving.";
  if (args.ci !== null && args.ci !== "success") return "CI has not passed for this commit, so its image may not exist.";
  return null;
}

/** The workflow names the runs show, once each: what the automatic-deploy and preview forms suggest. */
export function workflowNames(runs: Pick<WorkflowRun, "name">[]): string[] {
  return [...new Set(runs.map((r) => r.name).filter((n) => n !== ""))];
}

/** How what runs compares with the head of the linked branch. */
export type ServingState =
  | { kind: "nothing" }
  /** The running image is not tagged with a commit SHA. */
  | { kind: "untagged" }
  | { kind: "current" }
  | { kind: "behind"; by: number }
  /** GitHub could not say. */
  | { kind: "unknown" };

export function servingState(serving: string | null, servingSha: string | null, aheadBy: number | null): ServingState {
  if (serving === null) return { kind: "nothing" };
  if (servingSha === null) return { kind: "untagged" };
  if (aheadBy === null) return { kind: "unknown" };
  return aheadBy === 0 ? { kind: "current" } : { kind: "behind", by: aheadBy };
}

/** The sentence under the serving commit; null for `nothing` and `untagged`, which the card words itself. */
export function servingSentence(state: ServingState, branch: string): string | null {
  switch (state.kind) {
    case "current":
      return `Up to date with ${branch}.`;
    case "behind":
      return `${state.by} commit${state.by === 1 ? "" : "s"} behind ${branch}.`;
    case "unknown":
      return `Could not compare it with ${branch}.`;
    default:
      return null;
  }
}
