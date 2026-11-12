import type { DatabaseStatus, JobStatus } from "@/lib/agent-types";
import { databaseRows, type DatabaseRow } from "@/lib/databases-fleet-core";
import { jobConfigHref } from "@/lib/databases";
import type { HubDatabase, HubJob, JobVia, DatabaseVia } from "@/lib/project-hub-core";

// What the Jobs and Databases tabs of a project show and link to. Pure: the components lay it out.

export type HubTab = "jobs" | "databases";

/** Where the config forms send the user back to: the project's tab. */
export const hubTabPath = (project: string, tab: HubTab): string => `/projects/${encodeURIComponent(project)}/${tab}`;

/** A config page link that returns to `from` after save or cancel. */
export const withFrom = (href: string, from: string): string => `${href}?from=${encodeURIComponent(from)}`;

export const jobEditHref = (serverId: string, job: Pick<JobStatus, "name" | "kind">, from: string): string => withFrom(jobConfigHref(serverId, job), from);
export const newJobHref = (serverId: string, from: string): string => withFrom(`/servers/${serverId}/config/jobs/new`, from);
export const databaseEditHref = (serverId: string, name: string, from: string): string =>
  withFrom(`/servers/${serverId}/config/databases/${encodeURIComponent(name)}`, from);
export const newDatabaseHref = (serverId: string, from: string): string => withFrom(`/servers/${serverId}/config/databases/new`, from);
export const jobRunsHref = (serverId: string, name: string): string => `/servers/${serverId}/jobs/${encodeURIComponent(name)}`;
export const databasePageHref = (serverId: string, name: string): string => `/servers/${serverId}/databases/${encodeURIComponent(name)}`;

const JOB_VIA: Record<JobVia, (j: HubJob) => string> = {
  label: () => "Labelled with this project in the configuration",
  container: (j) => `Runs a command in a container of app ${j.app ?? "?"}`,
  "http-bearer": (j) => `Authenticates as app ${j.app ?? "?"} (bearer token)`,
  backup: (j) => `Backs up database ${j.database ?? "?"}`,
};
export const jobViaText = (j: HubJob): string => JOB_VIA[j.via](j);

const DATABASE_VIA: Record<DatabaseVia, (d: HubDatabase) => string> = {
  label: () => "Labelled with this project in the configuration",
  "managed-app": (d) => `Managed by app ${d.apps.join(", ") || "?"}`,
  "release-backup": (d) => `Backed up before the release of app ${d.apps.join(", ") || "?"}`,
};
export const databaseViaText = (d: HubDatabase): string => DATABASE_VIA[d.via](d);

export type JobState = "failed" | "running" | "paused" | "never-run" | "ok";

const JOB_ORDER: Record<JobState, number> = { failed: 0, "never-run": 1, paused: 2, running: 3, ok: 4 };

export function jobState(job: JobStatus): JobState {
  if (job.running || job.last_run?.status === "running") return "running";
  if (job.paused) return "paused";
  if (!job.last_run) return "never-run";
  return job.last_run.status === "failed" ? "failed" : "ok";
}

/** A job with the server it runs on: a project's `HubJob`, or any list entry. */
export interface JobLike {
  server: { name: string };
  job: JobStatus;
}

export interface JobRow<T extends JobLike = HubJob> {
  entry: T;
  state: JobState;
}

/** Failing first, then never run, paused, running, fine; each group by server then name. */
export function jobRows<T extends JobLike>(jobs: T[]): JobRow<T>[] {
  return jobs
    .map((entry) => ({ entry, state: jobState(entry.job) }))
    .sort(
      (a, b) =>
        JOB_ORDER[a.state] - JOB_ORDER[b.state] ||
        a.entry.server.name.localeCompare(b.entry.server.name) ||
        a.entry.job.name.localeCompare(b.entry.job.name),
    );
}

/**
 * A job that never ran needs a look only once its first run is late: one that is scheduled and has not reached its first run
 * yet (its next run is still ahead) is simply new. Without a next run it is not scheduled at all, which needs a look too.
 */
export const missedFirstRun = (row: JobRow<JobLike>, now: number): boolean => {
  if (row.state !== "never-run") return false;
  const next = row.entry.job.next_run === undefined ? NaN : Date.parse(row.entry.job.next_run);
  return !Number.isFinite(next) || next <= now;
};

export const jobsNeedingLook = (rows: JobRow<JobLike>[], now: number): number => rows.filter((r) => r.state === "failed" || missedFirstRun(r, now)).length;

/** A database with the server it is on: a project's `HubDatabase`, or any list entry. */
export interface DatabaseLike {
  server: { id: string; name: string };
  db: DatabaseStatus;
}

export type DatabaseEntryRow<T extends DatabaseLike = HubDatabase> = DatabaseRow & { entry: T };

/** The databases with their backup state, in the order of the Databases page: failing and overdue first. */
export function databaseEntryRows<T extends DatabaseLike>(databases: T[], now: number): DatabaseEntryRow<T>[] {
  const servers = new Map<string, { server: DatabaseLike["server"]; databases: DatabaseStatus[] }>();
  for (const d of databases) {
    const entry = servers.get(d.server.id) ?? { server: d.server, databases: [] };
    entry.databases.push(d.db);
    servers.set(d.server.id, entry);
  }
  const { rows } = databaseRows(
    [...servers.values()].map((s) => ({ server: { id: s.server.id, name: s.server.name }, reachable: true, lastSeen: now, databases: s.databases })),
    now,
  );
  const byKey = new Map(databases.map((d) => [`${d.server.id}/${d.db.name}`, d]));
  const out: DatabaseEntryRow<T>[] = [];
  for (const row of rows) {
    const entry = byKey.get(`${row.server.id}/${row.database.name}`);
    if (entry) out.push({ ...row, entry });
  }
  return out;
}

/** "Keeps the last 7 backups, 30 days": what retention the backup has. */
export function retentionText(backup: { keep: number; keep_days: number }): string {
  const parts: string[] = [];
  if (backup.keep > 0) parts.push(`last ${backup.keep}`);
  if (backup.keep_days > 0) parts.push(`${backup.keep_days} days`);
  return parts.length === 0 ? "Keeps every backup" : `Keeps ${parts.join(" and ")}`;
}

export const versionText = (engine: string, version: number): string =>
  `${engine === "postgres" ? "PostgreSQL" : engine}${version > 0 ? ` ${version}` : ""}`;

/** The config of a job or database with the project it belongs to; unchanged when it has none. */
export function withProject<T extends object>(config: T, project: string | undefined): T {
  return project ? { ...config, project } : config;
}
