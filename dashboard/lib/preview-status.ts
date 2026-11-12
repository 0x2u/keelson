import { GithubError } from "@/lib/github";
import type { CommitStatusState } from "@/lib/github-core";
import type { Deployment } from "@/lib/agent-types";

/** How often the deployment is read, and how long it is followed before giving up. */
export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** A build adds its own time (up to the agent's limit of an hour) to the deployment's. */
export const BUILD_POLL_INTERVAL_MS = 10_000;
export const BUILD_POLL_TIMEOUT_MS = 75 * 60 * 1000;

/** What following a deployment needs from outside: GitHub's status API, the agent, and the clock. Replaced in tests. */
export interface StatusDeps {
  post(state: CommitStatusState, description: string, targetUrl?: string): Promise<void>;
  deployment(id: string): Promise<Pick<Deployment, "status" | "error">>;
  sleep(ms: number): Promise<void>;
  now(): number;
  intervalMs?: number;
  timeoutMs?: number;
}

function reason(err: unknown): string {
  return err instanceof GithubError ? err.message : err instanceof Error ? err.message : "unexpected error";
}

/** What a followed deployment is reported as. */
interface Wording {
  /** The state's description while it runs. */
  pending: string;
  success: string;
  /** Followed by ": <error>" or " (<status>)". */
  failure: string;
  timeout: string;
}

export interface Followed {
  /** Null when everything was reported, or "status not reported: <reason>" for the delivery's detail. */
  note: string | null;
  /** The deployment's own error when it ended without succeeding (not when it could not be followed to the end): what a build row must say. */
  failed: string | null;
}

/**
 * Reports a deployment on its commit: `pending` now, then `success` (with `url`) or `failure` once the deployment has
 * finished, reading it every few seconds until the timeout. It never throws. When GitHub refuses the first post (no
 * write access) nothing else is tried.
 */
async function report(args: { deploymentId: string; url?: string; successUrl?: string; pendingUrl?: string; wording: Wording }, deps: StatusDeps): Promise<Followed> {
  const { wording } = args;
  try {
    await deps.post("pending", wording.pending, args.pendingUrl);
  } catch (err) {
    return { note: `status not reported: ${reason(err)}`, failed: null };
  }

  const interval = deps.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = deps.now() + (deps.timeoutMs ?? POLL_TIMEOUT_MS);
  let lastError: string | null = null;
  let failed: string | null = null;
  let final: { state: CommitStatusState; description: string; url?: string } | null = null;
  for (;;) {
    try {
      const d = await deps.deployment(args.deploymentId);
      lastError = null;
      if (d.status === "succeeded") {
        final = { state: "success", description: wording.success, url: args.successUrl ?? args.pendingUrl };
        break;
      }
      if (d.status !== "running") {
        failed = d.error ? d.error : d.status;
        final = { state: "failure", description: `${wording.failure}${d.error ? `: ${d.error}` : ` (${d.status})`}`, url: args.pendingUrl };
        break;
      }
    } catch (err) {
      lastError = reason(err);
    }
    if (deps.now() + interval > deadline) break;
    await deps.sleep(interval);
  }
  final ??= { state: "failure", description: lastError === null ? wording.timeout : `Could not follow the deployment: ${lastError}`, url: args.pendingUrl };

  try {
    await deps.post(final.state, final.description, final.url);
  } catch (err) {
    return { note: `status not reported: ${reason(err)}`, failed };
  }
  return { note: null, failed };
}

/**
 * Reports a preview's deployment on its commit (see `report`): `success` links the preview. `building`: the
 * deployment includes the agent's build of the commit.
 */
export async function reportPreviewDeployment(args: { deploymentId: string; url: string; building?: boolean }, deps: StatusDeps): Promise<Followed> {
  return report(
    {
      deploymentId: args.deploymentId,
      successUrl: args.url,
      wording: {
        pending: args.building ? "Preview building and deploying" : "Preview deploying",
        success: "Preview deployed",
        failure: args.building ? "Preview build or deploy failed" : "Preview deploy failed",
        timeout: "Preview did not finish deploying in time; check Keelson",
      },
    },
    deps,
  );
}

/** The same, answering only what is left to note in the delivery: null when everything was reported, else "status not reported: <reason>". */
export async function reportPreview(args: { deploymentId: string; url: string }, deps: StatusDeps): Promise<string | null> {
  return (await reportPreviewDeployment(args, deps)).note;
}

/** Reports the GitHub App's build of a commit (see `report`); the deployment's page, when the dashboard knows its address, is the link. */
export async function reportBuild(args: { deploymentId: string; deploymentUrl?: string }, deps: StatusDeps): Promise<Followed> {
  return report(
    {
      deploymentId: args.deploymentId,
      pendingUrl: args.deploymentUrl,
      wording: { pending: "Building", success: "Built and deployed", failure: "Build or deploy failed", timeout: "Did not finish in time; check Keelson" },
    },
    deps,
  );
}
