import { versionOf } from "@/lib/image-ref-core";
import type { BackupState } from "@/lib/databases-fleet-core";
import type { CheckState } from "@/lib/domain-status-core";
import type { CommitDeployment, RunState } from "@/lib/github-core";
import type { DeliveryOutcome } from "@/lib/github-webhook-core";
import type { JobState } from "@/lib/project-hub-jobs-core";
import type { ReadinessState } from "@/lib/readiness-core";

// The one status vocabulary: every state the dashboard shows as a badge or a dot has exactly one tone and one label here,
// in one table per domain. Components never write a {tone, label} of their own; they look a state up (or use the badge
// built on the table). Where two domains share a word ("Starting", "Running", "Failed") they share its tone.

/** The tone of a status: success (fine), warning (look at it), danger (broken), info (in motion or neutral news), muted (nothing to say). */
export type Tone = "success" | "warning" | "danger" | "info" | "muted";

/** What a status looks like on screen: one tone, one label, and whether it is still in motion. */
export interface StatusView {
  tone: Tone;
  label: string;
  /** In progress: the indicator pulses. */
  live?: boolean;
}

const STARTING: StatusView = { tone: "info", label: "Starting", live: true };
const NOT_DEPLOYED: StatusView = { tone: "muted", label: "Not deployed" };

/** A deployment as the agent records it. */
export const DEPLOYMENTS: Record<string, StatusView> = {
  running: { tone: "info", label: "Deploying", live: true },
  succeeded: { tone: "success", label: "Succeeded" },
  failed: { tone: "danger", label: "Failed" },
  rolled_back: { tone: "warning", label: "Deploy rolled back" },
  rollback_failed: { tone: "danger", label: "Rollback failed" },
};

/** A deployment that was a roll back and worked: what happened is the roll back, not "Succeeded". */
const ROLLED_BACK: StatusView = { tone: "success", label: "Rolled back" };

/** The steps of a deployment's pipeline (see lib/pipeline-core): what each one reads as. A step is never told by its colour alone. */
export const PIPELINE_STEPS = {
  running: { tone: "info", label: "In progress", live: true },
  done: { tone: "success", label: "Succeeded" },
  failed: { tone: "danger", label: "Failed" },
  skipped: { tone: "muted", label: "Skipped" },
  pending: { tone: "muted", label: "Not started" },
  notReached: { tone: "muted", label: "Not reached" },
  elsewhere: { tone: "muted", label: "Built on another server" },
} as const satisfies Record<string, StatusView>;

/** What a commit's deployment is, as the Source page lists commits. */
export const COMMIT_DEPLOYMENTS: Record<CommitDeployment, StatusView> = {
  serving: { tone: "success", label: "Serving" },
  deploying: DEPLOYMENTS.running,
  deployed: { tone: "muted", label: "Deployed before" },
  failed: { tone: "danger", label: "Deploy failed" },
};

/** One run of a job (or of a backup). */
export const JOB_RUNS: Record<string, StatusView> = {
  running: { tone: "info", label: "Running now", live: true },
  succeeded: { tone: "success", label: "Succeeded" },
  failed: { tone: "danger", label: "Failed" },
  skipped: { tone: "muted", label: "Skipped" },
};

/** Where a job stands, from its schedule and its last run. */
export const JOB_STATES: Record<JobState, StatusView> = {
  failed: { tone: "danger", label: "Last run failed" },
  running: { tone: "info", label: "Running now", live: true },
  paused: { tone: "muted", label: "Paused" },
  "never-run": { tone: "warning", label: "Never run" },
  ok: { tone: "success", label: "Last run succeeded" },
};

/** Where a database's backups stand. */
export const BACKUP_STATES: Record<BackupState, StatusView> = {
  failed: { tone: "danger", label: "Last backup failed" },
  overdue: { tone: "warning", label: "Overdue" },
  "never-scheduled": { tone: "warning", label: "No backup and none scheduled" },
  "not-configured": { tone: "warning", label: "No backup configured" },
  paused: { tone: "muted", label: "Backups paused" },
  "first-pending": { tone: "info", label: "First backup scheduled" },
  running: { tone: "info", label: "Backing up now", live: true },
  ok: { tone: "success", label: "Backed up" },
};

/**
 * Where a readiness check stands (see lib/readiness-core). Its own table, not the attention model's severities: a check that
 * was never done is not an incident, so it is "To do" in the neutral news tone; "Needs a look" is a proof gone stale or a
 * backup overdue, "Failing" a restore test or a backup that failed.
 */
export const READINESS: Record<ReadinessState, StatusView> = {
  ok: { tone: "success", label: "Passing" },
  warning: { tone: "warning", label: "Needs a look" },
  critical: { tone: "danger", label: "Failing" },
  todo: { tone: "info", label: "To do" },
  na: { tone: "muted", label: "Not applicable" },
};

/** What a webhook delivery did to an app, as the Source page shows it. */
export const DELIVERY_OUTCOMES: Record<DeliveryOutcome, StatusView> = {
  pending: { tone: "info", label: "In progress", live: true },
  unknown: { tone: "warning", label: "Unknown" },
  deployed: { tone: "success", label: "Deployed" },
  skipped: { tone: "muted", label: "Skipped" },
  failed: { tone: "danger", label: "Failed" },
};

/** A preview environment of a pull request. */
export const PREVIEWS: Record<"deploying" | "running" | "failed", StatusView> = {
  deploying: DEPLOYMENTS.running,
  running: { tone: "success", label: "Running" },
  failed: { tone: "danger", label: "Failed" },
};

export const CI_RUNS: Record<RunState, StatusView> = {
  success: { tone: "success", label: "CI passed" },
  failure: { tone: "danger", label: "CI failed" },
  running: { tone: "info", label: "CI running", live: true },
  queued: { tone: "muted", label: "CI queued" },
  cancelled: { tone: "muted", label: "CI cancelled" },
  other: { tone: "warning", label: "CI neutral" },
};

/** One of a domain's checks (DNS, proxy, HTTPS). */
export const DOMAIN_CHECKS: Record<CheckState, StatusView> = {
  ok: { tone: "success", label: "OK" },
  pending: { tone: "warning", label: "Waiting", live: true },
  failed: { tone: "danger", label: "Failed" },
  skipped: { tone: "muted", label: "Skipped" },
};

/** What an action's outcome reads as in the activity feed when it has no state of its own. */
export const ACTION_OUTCOMES = {
  done: { tone: "muted", label: "Done" },
  failed: { tone: "danger", label: "Failed" },
} as const satisfies Record<string, StatusView>;

/** A container by the state Docker reports (a running one is told apart by its health check in `containerStatus`). */
export const CONTAINER_STATES: Record<string, StatusView> = {
  created: { tone: "muted", label: "Created" },
  running: { tone: "success", label: "Running" },
  paused: { tone: "muted", label: "Paused" },
  restarting: { tone: "danger", label: "Restarting" },
  removing: { tone: "muted", label: "Removing" },
  exited: { tone: "danger", label: "Stopped" },
  dead: { tone: "danger", label: "Dead" },
};

/** A running container with a health check: "Healthy" is said only where one exists, else "Running". */
export const CONTAINER_HEALTH: Record<"healthy" | "unhealthy" | "starting", StatusView> = {
  healthy: { tone: "success", label: "Healthy" },
  unhealthy: { tone: "danger", label: "Unhealthy" },
  starting: STARTING,
};

/** An app placement that has no container to describe. */
export const PLACEMENTS = {
  notDeployed: NOT_DEPLOYED,
} as const satisfies Record<string, StatusView>;

/** Where an environment (an app within a project) stands, in one word. A failed latest deployment keeps "Running" but warns. */
export const ENVIRONMENTS = {
  notDeployed: NOT_DEPLOYED,
  deploying: DEPLOYMENTS.running,
  starting: STARTING,
  running: { tone: "success", label: "Running" },
  runningLastFailed: { tone: "warning", label: "Running" },
  down: { tone: "danger", label: "Down" },
  error: { tone: "danger", label: "Error" },
} as const satisfies Record<string, StatusView>;

/** A server: reachable with nothing to look at is Online; with something, the attention model's verdict; otherwise Offline (a machine that connects out) or Unreachable. */
export const SERVER_STATES = {
  online: { tone: "success", label: "Online" },
  offline: { tone: "muted", label: "Offline" },
  unreachable: { tone: "danger", label: "Unreachable" },
} as const satisfies Record<string, StatusView>;

/** A proxy's routes against its configuration, and a site route against a container route. */
export const PROXY_STATES = {
  inSync: { tone: "success", label: "In sync" },
  site: { tone: "muted", label: "Site" },
  routeRunning: { tone: "success", label: "Running" },
  routeDown: { tone: "danger", label: "Not running" },
} as const satisfies Record<string, StatusView>;

const unknown = (label: string): StatusView => ({ tone: "muted", label });

/**
 * A deployment's status; with its trigger, a roll back that succeeded reads "Rolled back to <version>" (plain "Rolled back"
 * where the image it went to is not known), so it never collides with `rolled_back`, the agent's automatic return to the
 * previous version after a failed deploy ("Deploy rolled back"). `ref` is the image the deployment put in service. The one
 * place that decides it.
 */
export const deploymentStatus = (status: string, trigger?: string, ref?: string): StatusView =>
  status === "succeeded" && trigger === "rollback" ? rolledBack(ref) : (DEPLOYMENTS[status] ?? unknown(status));

const rolledBack = (ref?: string): StatusView => (ref ? { tone: ROLLED_BACK.tone, label: `${ROLLED_BACK.label} to ${versionOf(ref)}` } : ROLLED_BACK);
export const jobRunStatus = (status: string): StatusView => JOB_RUNS[status] ?? unknown(status);
export const ciStatus = (state: RunState): StatusView => CI_RUNS[state];
export const domainCheckStatus = (state: CheckState): StatusView => DOMAIN_CHECKS[state];

/** A webhook delivery's outcome. */
export const deliveryStatus = (outcome: DeliveryOutcome): StatusView => DELIVERY_OUTCOMES[outcome];

/** An activity event carries its status as plain fields; this is the view of them. */
export const eventStatus = (e: { tone: Tone; status: string; live?: boolean }): StatusView => ({ tone: e.tone, label: e.status, ...(e.live ? { live: true } : {}) });

const capitalised = (s: string): string => (s === "" ? s : s[0].toUpperCase() + s.slice(1));

/** A container: Docker's state (every word capitalised, never raw), and for a running one its health check. */
export function containerStatus(state: string, health?: string): StatusView {
  if (state !== "running") return CONTAINER_STATES[state] ?? unknown(capitalised(state));
  if (health === "unhealthy" || health === "starting" || health === "healthy") return CONTAINER_HEALTH[health];
  return CONTAINER_STATES.running;
}

/** What the attention model says of one server (`count` items, worst `tone`, sentence `label`). */
export interface ServerAttention {
  tone: Tone;
  label: string;
  count: number;
}

/**
 * The status of a server, the same in every place that shows one (Home, the servers list, the server's header, the
 * sidebar): "Online" only when it answers and nothing needs attention, else the attention verdict. A server that does
 * not answer is Offline when it is a machine that connects out (not an incident) and Unreachable otherwise.
 */
export function serverStatus(s: { reachable: boolean; machine?: boolean; attention?: ServerAttention }): StatusView {
  if (!s.reachable) return s.machine ? SERVER_STATES.offline : SERVER_STATES.unreachable;
  const a = s.attention;
  if (a === undefined || a.count === 0) return SERVER_STATES.online;
  return { tone: a.tone, label: a.label };
}
