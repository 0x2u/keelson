/** A toast that answers: what happened, and a link to the thing that was created. */
export interface OutcomeToast {
  title: string;
  description?: string;
  action: { label: string; href: string };
  /** Milliseconds on screen; Infinity stays until dismissed. */
  duration: number;
}

/** Long enough to read, decide and click. */
export const ACTION_TOAST_MS = 15_000;

export type DeployKind = "deploy" | "rollback" | "promotion";

const TITLE: Record<DeployKind, (app: string) => string> = {
  deploy: (app) => `Deploying ${app}`,
  rollback: (app) => `Rolling back ${app}`,
  promotion: (app) => `Promoting ${app}`,
};

/** After a Deploy, a Roll back or a Promote was accepted: which versions (tags or short digests), and a link to its log. */
export function deploymentToast(kind: DeployKind, o: { serverId: string; deploymentId: string; app: string; from?: string; to: string }): OutcomeToast {
  return {
    title: TITLE[kind](o.app),
    description: o.from ? `${o.from} → ${o.to}` : o.to,
    action: { label: "View log", href: `/servers/${o.serverId}/deployments/${o.deploymentId}` },
    duration: ACTION_TOAST_MS,
  };
}

/** The page that shows the output of one run of a job. */
export function jobRunHref(serverId: string, job: string, runId: string): string {
  return `/servers/${serverId}/jobs/${encodeURIComponent(job)}?run=${encodeURIComponent(runId)}#run-${encodeURIComponent(runId)}`;
}

/** The page that shows one run of a database's backup job or restore. */
export function databaseRunHref(serverId: string, database: string, runId?: string): string {
  const base = `/servers/${serverId}/databases/${encodeURIComponent(database)}`;
  return runId ? `${base}?run=${encodeURIComponent(runId)}#run-${encodeURIComponent(runId)}` : base;
}

/**
 * After Run now or Backup now: the run is asynchronous, so the toast stays until dismissed and opens its output. The
 * backup of a database is shown on the database's page (`database`), any other job on its own page.
 */
export function jobRunToast(o: { serverId: string; job: string; runId?: string; label?: string; database?: string }): OutcomeToast {
  const href = o.database
    ? databaseRunHref(o.serverId, o.database, o.runId)
    : o.runId
      ? jobRunHref(o.serverId, o.job, o.runId)
      : `/servers/${o.serverId}/jobs/${encodeURIComponent(o.job)}`;
  return { title: `${o.label ?? "Run"} started`, description: o.job, action: { label: o.runId ? "View output" : "View runs", href }, duration: Number.POSITIVE_INFINITY };
}

/** After a restore was accepted: its progress and the row counts at the end are on the database's page. */
export function restoreToast(o: { serverId: string; database: string; runId?: string }): OutcomeToast {
  return {
    title: "Restore started",
    description: o.database,
    action: { label: "View restore", href: databaseRunHref(o.serverId, o.database, o.runId) },
    duration: Number.POSITIVE_INFINITY,
  };
}

/** A thing named in a toast: no trailing period, no surrounding whitespace. */
function thing(name: string): string {
  return name.trim().replace(/[.\s]+$/, "");
}

type Verb = "saved" | "added" | "removed" | "deleted" | "restored" | "updated" | "created" | "copied" | "revoked" | "unlocked";

const PAST: Record<Verb, string> = {
  saved: "Saved",
  added: "Added",
  removed: "Removed",
  deleted: "Deleted",
  restored: "Restored",
  updated: "Updated",
  created: "Created",
  copied: "Copied",
  revoked: "Revoked",
  unlocked: "Unlocked",
};

const BARE: Record<Verb, string> = {
  saved: "save",
  added: "add",
  removed: "remove",
  deleted: "delete",
  restored: "restore",
  updated: "update",
  created: "create",
  copied: "copy",
  revoked: "revoke",
  unlocked: "unlock",
};

/**
 * The one template of outcome toasts: "<Verb> <thing>" for success, "Could not <verb> <thing>" for a failure that happened
 * outside the surface the operator is looking at. Sentence case, no trailing period.
 */
export const toastCopy = {
  done: (verb: Verb, name: string): string => `${PAST[verb]} ${thing(name)}`,
  failed: (verb: Verb, name: string): string => `Could not ${BARE[verb]} ${thing(name)}`,
  saved: (name: string): string => `Saved ${thing(name)}`,
  added: (name: string): string => `Added ${thing(name)}`,
  removed: (name: string): string => `Removed ${thing(name)}`,
  deleted: (name: string): string => `Deleted ${thing(name)}`,
  restored: (name: string): string => `Restored ${thing(name)}`,
  updated: (name: string): string => `Updated ${thing(name)}`,
  created: (name: string): string => `Created ${thing(name)}`,
  revoked: (name: string): string => `Revoked ${thing(name)}`,
  copied: (name: string): string => `Copied ${thing(name)}`,
} as const;
