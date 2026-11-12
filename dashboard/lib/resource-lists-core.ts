import type { AppStatus, ConfigModel, DatabaseStatus, JobStatus } from "@/lib/agent-types";
import type { UnansweredServer } from "@/lib/databases-fleet-core";
import { projectMembers, projectPlacements, type HubDatabase, type HubJob, type ServerFacts } from "@/lib/project-hub-core";
import { newDatabaseHref, newJobHref } from "@/lib/project-hub-jobs-core";
import { groupProjects, jobsOf, type Placement, type ServerRef } from "@/lib/projects-core";

// The global lists of jobs and databases (`/jobs`, `/databases`, the project tabs and the home page all render the same two
// tables): which entries exist across the servers and which project each belongs to, the `?server=` / `?project=` filter
// and where "Add" and "Edit" lead. Pure: the loader gathers what the agents said, the tables only lay it out.

/** One job on one server, with the project it belongs to (and why, when a project's rules claimed it). */
export interface JobEntry {
  server: ServerRef;
  job: JobStatus;
  project?: string;
  hub?: HubJob;
}

/** One database on one server, with the project it belongs to (and why). */
export interface DatabaseEntry {
  server: ServerRef;
  db: DatabaseStatus;
  project?: string;
  hub?: HubDatabase;
}

/** What one server answered, for the lists. `config` is null when its configuration could not be read. */
export interface ListFacts {
  server: ServerRef;
  reachable: boolean;
  /** Why it did not answer. */
  reason?: string;
  apps?: AppStatus[] | null;
  jobs?: JobStatus[] | null;
  databases?: DatabaseStatus[] | null;
  /** The parts that failed although the server answered, with why: unknown, not empty. */
  errors?: Record<string, string>;
  config: ConfigModel | null;
}

export interface FleetLists {
  jobs: JobEntry[];
  databases: DatabaseEntry[];
  /** Servers whose jobs / databases are unknown (they did not answer, or that part failed), with why. */
  unansweredJobs: UnansweredServer[];
  unansweredDatabases: UnansweredServer[];
  /** Every server given, answering or not: where something can be added and what the server filter offers. */
  servers: ServerRef[];
  /** The projects that have apps, jobs or databases, sorted. */
  projects: string[];
  /** The servers that hold each project's apps: where a job or database of the project can be added. */
  projectServers: Record<string, ServerRef[]>;
}

const keyOf = (serverId: string, name: string): string => `${serverId}/${name}`;

/**
 * Every job and database of the servers that answered, each with its project: the one a project's rules claim (see
 * `projectMembers`: the label, the app a job acts on, the app a database serves), else the label the agent reports.
 */
export function fleetLists(facts: ListFacts[]): FleetLists {
  const unansweredJobs: UnansweredServer[] = [];
  const unansweredDatabases: UnansweredServer[] = [];
  const known: ServerFacts[] = [];
  for (const f of facts) {
    const ref = { id: f.server.id, name: f.server.name };
    if (!f.reachable) {
      unansweredJobs.push({ ...ref, ...(f.reason === undefined ? {} : { reason: f.reason }) });
      unansweredDatabases.push({ ...ref, ...(f.reason === undefined ? {} : { reason: f.reason }) });
      continue;
    }
    const jobsError = f.errors?.jobs;
    const databasesError = f.errors?.databases;
    if (jobsError !== undefined) unansweredJobs.push({ ...ref, reason: jobsError });
    if (databasesError !== undefined) unansweredDatabases.push({ ...ref, reason: databasesError });
    known.push({
      server: f.server,
      apps: f.apps ?? [],
      jobs: jobsError === undefined ? (f.jobs ?? []) : [],
      databases: databasesError === undefined ? (f.databases ?? []) : [],
      config: f.config,
    });
  }

  const placements: Placement[] = known.flatMap((f) => f.apps.map((app): Placement => ({ server: f.server, app, jobs: jobsOf(app.name, f.jobs) })));
  const projects = groupProjects(placements);
  const jobProject = new Map<string, { project: string; hub: HubJob }>();
  const databaseProject = new Map<string, { project: string; hub: HubDatabase }>();
  for (const project of projects) {
    const members = projectMembers(project, known);
    for (const hub of members.jobs) if (!jobProject.has(keyOf(hub.server.id, hub.job.name))) jobProject.set(keyOf(hub.server.id, hub.job.name), { project: project.name, hub });
    for (const hub of members.databases) if (!databaseProject.has(keyOf(hub.server.id, hub.db.name))) databaseProject.set(keyOf(hub.server.id, hub.db.name), { project: project.name, hub });
  }

  const jobs: JobEntry[] = [];
  const databases: DatabaseEntry[] = [];
  for (const f of known) {
    for (const job of f.jobs) {
      const claimed = jobProject.get(keyOf(f.server.id, job.name));
      const project = claimed?.project ?? job.project;
      jobs.push({ server: f.server, job, ...(project ? { project } : {}), ...(claimed ? { hub: claimed.hub } : {}) });
    }
    for (const db of f.databases) {
      const claimed = databaseProject.get(keyOf(f.server.id, db.name));
      const project = claimed?.project ?? db.project;
      databases.push({ server: f.server, db, ...(project ? { project } : {}), ...(claimed ? { hub: claimed.hub } : {}) });
    }
  }
  const names = new Set<string>([...projects.map((p) => p.name), ...jobs.flatMap((j) => (j.project ? [j.project] : [])), ...databases.flatMap((d) => (d.project ? [d.project] : []))]);
  const projectServers = Object.fromEntries(
    projects.map((p) => [p.name, [...new Map(projectPlacements(p).map((pl) => [pl.server.id, pl.server])).values()]]),
  );
  return { jobs, databases, unansweredJobs, unansweredDatabases, servers: facts.map((f) => f.server), projects: [...names].sort((a, b) => a.localeCompare(b)), projectServers };
}

// ---- The filter in the address ------------------------------------------------------------------------------------------

export type ListKind = "jobs" | "databases";

/** `?server=<id>` and `?project=<name>`: what a list is narrowed to. */
export interface ListFilter {
  server?: string;
  project?: string;
}

const first = (v: string | string[] | undefined): string | undefined => {
  const value = Array.isArray(v) ? v[0] : v;
  return typeof value === "string" && value !== "" ? value : undefined;
};

export function parseListFilter(query: Record<string, string | string[] | undefined>): ListFilter {
  const server = first(query.server);
  const project = first(query.project);
  return { ...(server ? { server } : {}), ...(project ? { project } : {}) };
}

/** The address of a list narrowed to `filter`: it is also where Add and Edit return to. */
export function listHref(kind: ListKind, filter: ListFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.server) params.set("server", filter.server);
  if (filter.project) params.set("project", filter.project);
  const text = params.toString();
  return text === "" ? `/${kind}` : `/${kind}?${text}`;
}

/** What the table shows: a server's own, a project's across its servers, or everything. A server filter wins: then the server column is redundant. */
export type ListScope = "fleet" | "project" | "server";

export function listScope(filter: ListFilter): ListScope {
  return filter.server ? "server" : filter.project ? "project" : "fleet";
}

const matches = (filter: ListFilter, serverId: string, project: string | undefined): boolean =>
  (filter.server === undefined || filter.server === serverId) && (filter.project === undefined || filter.project === project);

export const filterJobs = (entries: JobEntry[], filter: ListFilter): JobEntry[] => entries.filter((e) => matches(filter, e.server.id, e.project));
export const filterDatabases = (entries: DatabaseEntry[], filter: ListFilter): DatabaseEntry[] => entries.filter((e) => matches(filter, e.server.id, e.project));

/** The servers that did not answer which a list narrowed to a server is about: only that server. Narrowed to a project (or not at all) every one counts: its part is unknown. */
export const filterUnanswered = (servers: UnansweredServer[], filter: ListFilter): UnansweredServer[] =>
  filter.server === undefined ? servers : servers.filter((s) => s.id === filter.server);

// ---- Add ----------------------------------------------------------------------------------------------------------------

export interface AddTarget {
  server: ServerRef;
  href: string;
}

/**
 * Where "Add job" / "Add database" can lead: one target per server the filter allows, each opening the configuration form
 * of that server with `from` as the way back (and the project, which the form reads from it).
 */
export function addTargets(kind: "job" | "database", servers: ServerRef[], from: string, filter: ListFilter = {}): AddTarget[] {
  const href = kind === "job" ? newJobHref : newDatabaseHref;
  return servers.filter((s) => filter.server === undefined || s.id === filter.server).map((server) => ({ server, href: href(server.id, from) }));
}

/** The servers a new job or database can go to under `filter`: a project's own servers when narrowed to a project, else every server. */
export function addServers(lists: Pick<FleetLists, "servers" | "projectServers">, filter: ListFilter): ServerRef[] {
  return (filter.project !== undefined ? lists.projectServers[filter.project] : undefined) ?? lists.servers;
}
