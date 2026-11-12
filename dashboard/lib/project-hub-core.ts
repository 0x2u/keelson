import type { AppStatus, ConfigModel, DatabaseConfig, DatabaseStatus, JobConfig, JobStatus } from "@/lib/agent-types";
import { isProblem, type BackupState } from "@/lib/databases-fleet-core";
import type { ProjectTabId } from "@/lib/nav-core";
import { databaseEntryRows, jobRows, jobsNeedingLook, missedFirstRun } from "@/lib/project-hub-jobs-core";
import { environmentState, type Placement, type Project, type ServerRef } from "@/lib/projects-core";

// What belongs to a project beyond its apps: the jobs and databases of the servers its apps run on, derived from what the
// agents already say (no agent change). A job or a database is attributed to an app on the SAME server; the member records
// why (`via`) so the page can say it. Everything on those servers that no app claims is returned as "unassigned", never dropped.
// An explicit `project` label on a job or a database (what its status says, or its entry in the configuration) wins over those
// rules: it belongs to that project, and to no other.

export type JobVia = "label" | "container" | "http-bearer" | "backup";
export type DatabaseVia = "label" | "managed-app" | "release-backup";

export interface HubJob {
  server: ServerRef;
  job: JobStatus;
  config?: JobConfig;
  via: JobVia;
  /** The app the job acts on or authenticates as (container and http-bearer; with a label, when it has one). */
  app?: string;
  /** The database a backup job backs up. */
  database?: string;
}

export interface HubDatabase {
  server: ServerRef;
  db: DatabaseStatus;
  config?: DatabaseConfig;
  via: DatabaseVia;
  /** The apps of the project that use it (managed for them, or backing it up in their release). */
  apps: string[];
}

/** What one server answered, for the members to be derived from. `config` is null when its configuration could not be read. */
export interface ServerFacts {
  server: ServerRef;
  apps: AppStatus[];
  jobs: JobStatus[];
  databases: DatabaseStatus[];
  config: ConfigModel | null;
}

export interface ProjectMembers {
  jobs: HubJob[];
  databases: HubDatabase[];
  unassignedJobs: { server: ServerRef; job: JobStatus }[];
  unassignedDatabases: { server: ServerRef; db: DatabaseStatus }[];
}

const CONTAINER_TARGET = /^container of (.+)$/;

/** The project a job or database says it belongs to: its status first, else its entry in the configuration; undefined when unlabelled. */
function labelOf(status: { project?: string }, config: { project?: string } | undefined): string | undefined {
  const label = status.project || config?.project;
  return label ? label : undefined;
}

/** The apps of this project on each server (id -> names), previews included. */
function projectApps(project: Project): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of project.environments.flatMap((e) => e.placements)) {
    const set = out.get(p.server.id) ?? new Set<string>();
    set.add(p.app.name);
    out.set(p.server.id, set);
  }
  return out;
}

/** Which apps of one server use each database: the one it was created for, and those whose release step backs it up. */
function databaseUsers(f: ServerFacts): { managed: Map<string, string>; release: Map<string, string[]> } {
  const names = new Set(f.apps.map((a) => a.name));
  const managed = new Map<string, string>();
  for (const d of f.databases) if (d.app && names.has(d.app)) managed.set(d.name, d.app);
  const release = new Map<string, string[]>();
  for (const app of f.config?.apps ?? []) {
    for (const step of app.release?.steps ?? []) {
      if (!step.backup) continue;
      const list = release.get(step.backup) ?? [];
      if (!list.includes(app.name)) list.push(app.name);
      release.set(step.backup, list);
    }
  }
  return { managed, release };
}

/** The database a backup job backs up: the one that names it, else the one `backup-<name>` points at. */
function backedUp(job: JobStatus, databases: DatabaseStatus[]): string | undefined {
  if (job.kind !== "backup") return undefined;
  const named = databases.find((d) => d.backup?.job === job.name);
  if (named) return named.name;
  return databases.find((d) => job.name === `backup-${d.name}`)?.name;
}

/** The app a job acts on or authenticates as, and how. */
function jobApp(job: JobStatus, config: JobConfig | undefined): { app: string; via: "container" | "http-bearer" } | undefined {
  if (job.kind === "container") {
    const app = CONTAINER_TARGET.exec(job.target)?.[1] ?? config?.container?.app;
    return app ? { app, via: "container" } : undefined;
  }
  const bearer = config?.http?.bearer?.app;
  if (job.kind === "http" && bearer) return { app: bearer, via: "http-bearer" };
  return undefined;
}

export function projectMembers(project: Project, facts: ServerFacts[]): ProjectMembers {
  const mine = projectApps(project);
  const out: ProjectMembers = { jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [] };

  for (const f of facts) {
    // A server without an app of the project still has the databases and jobs that carry its label; what no project claims
    // is offered ("unassigned") only on a server the project runs on.
    const ours = mine.get(f.server.id) ?? new Set<string>();
    const runsHere = mine.has(f.server.id);
    const onServer = new Set(f.apps.map((a) => a.name));
    const users = databaseUsers(f);

    // Databases first: a backup job follows its database.
    const owned = new Set<string>(); // databases some app of this server uses
    const member = new Set<string>(); // databases a project app uses
    for (const db of f.databases) {
      const managedBy = users.managed.get(db.name);
      const released = (users.release.get(db.name) ?? []).filter((a) => onServer.has(a));
      const config = f.config?.databases?.find((c) => c.name === db.name);
      const label = labelOf(db, config);
      const apps = [...new Set([...(managedBy ? [managedBy] : []), ...released])].filter((a) => ours.has(a));
      if (label !== undefined) {
        // Claimed by a project by name: no other rule applies, and it is not "unassigned".
        owned.add(db.name);
        if (label !== project.name) continue;
        member.add(db.name);
        out.databases.push({ server: f.server, db, config, via: "label", apps });
        continue;
      }
      if (managedBy || released.length > 0) owned.add(db.name);
      if (apps.length === 0) continue;
      member.add(db.name);
      out.databases.push({
        server: f.server,
        db,
        config,
        via: managedBy !== undefined && ours.has(managedBy) ? "managed-app" : "release-backup",
        apps,
      });
    }
    if (runsHere) for (const db of f.databases) if (!owned.has(db.name)) out.unassignedDatabases.push({ server: f.server, db });

    for (const job of f.jobs) {
      const config = f.config?.jobs?.find((c) => c.name === job.name);
      const database = backedUp(job, f.databases);
      const label = labelOf(job, config);
      if (label !== undefined) {
        if (label === project.name) out.jobs.push({ server: f.server, job, config, via: "label", app: jobApp(job, config)?.app, database });
        continue;
      }
      if (database !== undefined) {
        if (member.has(database)) out.jobs.push({ server: f.server, job, config, via: "backup", database });
        else if (runsHere && !owned.has(database)) out.unassignedJobs.push({ server: f.server, job });
        continue;
      }
      const target = jobApp(job, config);
      if (target && ours.has(target.app)) out.jobs.push({ server: f.server, job, config, via: target.via, app: target.app });
      else if (runsHere && (!target || !onServer.has(target.app))) out.unassignedJobs.push({ server: f.server, job });
    }
  }
  return out;
}

// ---- What the tab bar and the overview's cards say --------------------------------------------------------------------

export interface HubSummary {
  apps: { count: number; down: number };
  /** `look` is what the Jobs tab calls "need a look": failing plus never run. */
  jobs: { count: number; failing: number; neverRun: number; paused: number; look: number };
  /** `look` is what the Databases tab calls "need a look"; `pending` waits for its first scheduled backup (not a problem, not "backed up" either). */
  databases: { count: number; failed: number; overdue: number; unprotected: number; pending: number; look: number };
  /** Distinct public hostnames the project's environments answer on. */
  domains: { count: number };
}

/** Every placement of the project, once. */
export function projectPlacements(project: Project): Placement[] {
  return project.environments.flatMap((e) => e.placements);
}

/**
 * The counts of the tabs and the health of each overview card. Jobs and databases are judged by the tabs' own rules
 * (jobRows, databaseEntryRows), so a card never contradicts its tab. `now` is the time the page was read.
 */
export function hubSummary(project: Project, members: ProjectMembers, now: number): HubSummary {
  const placements = projectPlacements(project);
  const domains = new Set(project.environments.flatMap((e) => e.placements.flatMap((p) => p.app.domains ?? [])));
  const jobs = jobRows(members.jobs);
  const dbs = databaseEntryRows(members.databases, now);
  const dbCount = (...states: BackupState[]) => dbs.filter((d) => states.includes(d.state)).length;
  return {
    apps: { count: placements.length, down: placements.filter((p) => environmentState(p.app).tone === "danger").length },
    jobs: {
      count: jobs.length,
      failing: jobs.filter((j) => j.state === "failed").length,
      neverRun: jobs.filter((j) => missedFirstRun(j, now)).length,
      paused: jobs.filter((j) => j.state === "paused").length,
      look: jobsNeedingLook(jobs, now),
    },
    databases: {
      count: dbs.length,
      failed: dbCount("failed"),
      overdue: dbCount("overdue", "never-scheduled"),
      unprotected: dbCount("not-configured", "paused"),
      pending: dbCount("first-pending"),
      look: dbs.filter((d) => isProblem(d.state)).length,
    },
    domains: { count: domains.size },
  };
}

/** The tabs that need a look, for the dots of the tab bar: the same count each tab shows as "need a look". */
export function attentionTabs(summary: HubSummary, unreachable: number): ProjectTabId[] {
  const out: ProjectTabId[] = [];
  if (summary.apps.down > 0 || unreachable > 0) out.push("apps");
  if (summary.jobs.look > 0) out.push("jobs");
  if (summary.databases.look > 0) out.push("databases");
  return out;
}
