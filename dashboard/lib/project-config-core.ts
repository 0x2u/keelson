import {
  HIDDEN,
  type AppConfig,
  type ConfigFile,
  type ConfigIssue,
  type DatabaseConfig,
  type JobConfig,
  type ProjectConfigDocument,
  type ProjectFileSummary,
  type SplitKept,
  type SplitPlan,
} from "@/lib/agent-types";
import type { SaveNotice } from "@/lib/app-config-core";
import type { ProjectMembers, ServerFacts } from "@/lib/project-hub-core";
import type { ServerRef } from "@/lib/projects-core";

// The Configuration tab of a project, as pure functions: where the project's configuration lives on a server, what the file
// holds, what giving the project its own file would move, and where an issue of the bundle is. The components only lay it out.

/** The answer when an agent has no per-project files (it answers its router's plain 404 to the project routes). */
export const AGENT_TOO_OLD_FOR_PROJECT_FILES =
  "This agent is too old to keep a project in its own file. Update it from the server's page, then try again.";

/** Where the project's configuration lives on one server, from what GET /v1/projects answered (null: the agent has no such route). */
export type ConfigLocation = "old-agent" | "file" | "shared";

export function configLocation(files: ProjectFileSummary[] | null, project: string): ConfigLocation {
  if (files === null) return "old-agent";
  return files.some((f) => f.name === project) ? "file" : "shared";
}

export interface EntityCounts {
  apps: number;
  jobs: number;
  databases: number;
}

const COUNT_NOUNS: { key: keyof EntityCounts; one: string; many: string }[] = [
  { key: "apps", one: "app", many: "apps" },
  { key: "jobs", one: "job", many: "jobs" },
  { key: "databases", one: "database", many: "databases" },
];

/** "2 apps, 1 job and 1 database": what is there, nothing that is not. */
export function countsText(counts: EntityCounts): string {
  const parts = COUNT_NOUNS.filter((n) => counts[n.key] > 0).map((n) => `${counts[n.key]} ${counts[n.key] === 1 ? n.one : n.many}`);
  if (parts.length === 0) return "no apps, jobs or databases";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the page says about a project's own file: whether it is the one in force, and why not. */
export interface ProjectFileView {
  path: string;
  hash: string;
  modifiedAt: string;
  counts: EntityCounts;
  inForce: boolean;
  /** Why the file on disk is not the one in force, with its file and line, as the agent gave it. */
  error?: string;
  /** What the editor shows: the file in force when the one on disk is not. */
  contentIsInForce: boolean;
}

export function projectFileView(doc: ProjectConfigDocument): ProjectFileView {
  const inForce = doc.error === undefined && doc.applied_hash !== "" && doc.applied_hash === doc.hash;
  return {
    path: doc.path,
    hash: doc.hash,
    modifiedAt: doc.modified_at,
    counts: {
      apps: doc.model.apps?.length ?? 0,
      jobs: doc.model.jobs?.length ?? 0,
      databases: doc.model.databases?.length ?? 0,
    },
    inForce,
    error: doc.error,
    contentIsInForce: !inForce,
  };
}

/**
 * What one server says about where the project's configuration lives: the answer of the agent, plus the derived view of
 * what the project holds (from the merged model) for the servers that have no file for it.
 */
export type ServerProjectConfig = {
  server: ServerRef;
  /** The server runs no apps itself (a machine that connects out): the agent cannot be updated from here. */
  machine: boolean;
  derived: DerivedProject | null;
  /** The spellings of this project's configuration that have a new name (empty when the server's files are current). */
  deprecations: ConfigIssue[];
} & (
  | { source: "file"; doc: ProjectConfigDocument }
  | { source: "shared" }
  /** The agent has no per-project files (it answered 404 to GET /v1/projects): the derived view is all there is. */
  | { source: "old-agent" }
  /** The agent did not answer, or answered an error: what is there is not known. */
  | { source: "unavailable"; reason: string }
);

/** The fragment of a server's section of the tab, for a link that lands on the editor of that server. */
export const serverSectionId = (serverId: string): string => `config-${serverId}`;

/** The Configuration tab of the project, at one server's section. */
export const projectConfigHref = (project: string, serverId?: string): string =>
  `/projects/${encodeURIComponent(project)}/config${serverId === undefined ? "" : `#${serverSectionId(serverId)}`}`;

/** The server's version history: the configuration is versioned as a whole there, project files included. */
export const versionsHref = (serverId: string): string => `/servers/${serverId}/config/versions`;

export const VERSIONED_AS_A_WHOLE =
  "The configuration is versioned as a whole: a version holds the apps file and every project file of the server together, and restoring one puts all of them back.";

/** What the user is told when the project got its own file: where it is, and that what runs did not change. */
export function splitNotice(project: string, serverId: string, file: string): SaveNotice {
  return {
    title: `${file} created`,
    description: `${project} now has its own file. What runs did not change.`,
    action: { label: "Open the editor", href: projectConfigHref(project, serverId) },
    persistent: false,
  };
}

/** The entries a project's file holds, by kind: what leaves the configuration when the file is removed. */
export function fileEntities(model: ProjectConfigDocument["model"]): SplitMove[] {
  return (
    [
      { label: "Apps", names: (model.apps ?? []).map((a) => a.name) },
      { label: "Jobs", names: (model.jobs ?? []).map((j) => j.name) },
      { label: "Databases", names: (model.databases ?? []).map((d) => d.name) },
    ] satisfies SplitMove[]
  ).filter((m) => m.names.length > 0);
}

// ---- The derived view: what the project holds when it has no file of its own -------------------------------------------

export interface DerivedProject {
  apps: AppConfig[];
  jobs: JobConfig[];
  databases: DatabaseConfig[];
}

/**
 * The entries of one server's merged configuration that belong to the project: its apps (labelled with it, or named for it),
 * and the jobs and databases the hub attributes to it. null when the server's configuration could not
 * be read, which is not the same as holding nothing.
 */
export function derivedProject(project: string, server: ServerRef, facts: ServerFacts | undefined, members: ProjectMembers): DerivedProject | null {
  const config = facts?.config;
  if (!config) return null;
  const apps = (config.apps ?? []).filter((a) => (a.project || a.name) === project);
  return {
    apps,
    jobs: members.jobs.filter((j) => j.server.id === server.id && j.config).map((j) => j.config as JobConfig),
    databases: members.databases.filter((d) => d.server.id === server.id && d.config).map((d) => d.config as DatabaseConfig),
  };
}

export const derivedCounts = (d: DerivedProject): EntityCounts => ({ apps: d.apps.length, jobs: d.jobs.length, databases: d.databases.length });

const PLAIN = /^[A-Za-z_][A-Za-z0-9_./@%+=,:-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n)$/i;

function scalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  if (value === HIDDEN) return value;
  return PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function block(value: object, pad: string): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined) continue;
      if (isScalar(item)) out.push(`${pad}- ${scalar(item)}`);
      else if (Array.isArray(item) ? item.length === 0 : Object.keys(item as object).length === 0) out.push(`${pad}- ${Array.isArray(item) ? "[]" : "{}"}`);
      else {
        const inner = block(item as object, `${pad}  `);
        inner[0] = `${pad}- ${inner[0].slice(pad.length + 2)}`;
        out.push(...inner);
      }
    }
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (isScalar(item)) out.push(`${pad}${scalar(key)}: ${scalar(item)}`);
    else if (Array.isArray(item) ? item.length === 0 : Object.keys(item as object).length === 0) out.push(`${pad}${scalar(key)}: ${Array.isArray(item) ? "[]" : "{}"}`);
    else {
      out.push(`${pad}${scalar(key)}:`, ...block(item as object, `${pad}  `));
    }
  }
  return out;
}

/**
 * The derived entries written as the YAML they would be in a project file: apps, jobs, databases, in that order,
 * each section only when it has entries. The agent's model already shows secrets as <hidden>; nothing here adds a value.
 */
export function derivedYaml(d: DerivedProject): string {
  const sections: [string, object[]][] = [
    ["apps", d.apps],
    ["jobs", d.jobs],
    ["databases", d.databases],
  ];
  const lines = sections.filter(([, list]) => list.length > 0).flatMap(([key, list]) => [`${key}:`, ...block(list, "  ")]);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ---- The split plan -------------------------------------------------------------------------------------------------------

export interface SplitMove {
  label: "Apps" | "Jobs" | "Databases";
  names: string[];
}

export interface SplitPlanView {
  file: string;
  moves: SplitMove[];
  moved: number;
  kept: SplitKept[];
  /** "Moves 1 app and 2 jobs into projects.d/shop.yaml." */
  summary: string;
}

/** What giving the project its own file moves, in the order the file will hold it, and what stays in the apps file and why. */
export function splitPlanView(plan: SplitPlan): SplitPlanView {
  const moves: SplitMove[] = (
    [
      { label: "Apps", names: plan.apps },
      { label: "Jobs", names: plan.jobs },
      { label: "Databases", names: plan.databases },
    ] satisfies SplitMove[]
  ).filter((m) => m.names.length > 0);
  const counts: EntityCounts = { apps: plan.apps.length, jobs: plan.jobs.length, databases: plan.databases.length };
  const moved = moves.reduce((n, m) => n + m.names.length, 0);
  return {
    file: plan.file,
    moves,
    moved,
    kept: plan.kept,
    summary: moved === 0 ? `Nothing moves into ${plan.file}.` : `Moves ${countsText(counts)} into ${plan.file}.`,
  };
}

/** "database shop": how a kept member is named. */
export const keptLabel = (k: SplitKept): string => `${k.kind} ${k.name}`;

// ---- Issues: file and line ------------------------------------------------------------------------------------------------

/** Where an issue is: "projects.d/shop.yaml, line 12", "line 12" (a single document), or the file alone. */
export function issueWhere(issue: ConfigIssue): string | undefined {
  const parts = [issue.file, issue.line === undefined ? undefined : `line ${issue.line}`].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Whether an issue's line is a line of the document being edited: it has no file (a configuration without project files), or
 * its file is the edited one. An issue of another file of the bundle is shown, but its line cannot be jumped to here.
 */
export const issueInFile = (issue: ConfigIssue, file: string | undefined): boolean => issue.file === undefined || file === undefined || issue.file === file;

/** The issues of the bundle that are in one file, for the editor to mark. */
export const issuesInFile = (issues: ConfigIssue[], file: string | undefined): ConfigIssue[] => issues.filter((i) => issueInFile(i, file));

// ---- The server configuration page's list of files ------------------------------------------------------------------------

export interface ConfigFileRow {
  path: string;
  /** "" for the apps file. */
  project: string;
  hash: string;
  shortHash: string;
  modifiedAt: string;
  /** The project's hub tab where its file is edited; none for the apps file. */
  href?: string;
}

/** The files of the bundle, apps file first as the agent lists them. Empty when there are no project files (a lone apps file needs no list). */
export function configFileRows(files: ConfigFile[] | undefined): ConfigFileRow[] {
  if (!files || files.length < 2) return [];
  return files.map((f) => ({
    path: f.path,
    project: f.project,
    hash: f.hash,
    shortHash: f.hash.slice(0, 12),
    modifiedAt: f.modified_at,
    href: f.project === "" ? undefined : `/projects/${encodeURIComponent(f.project)}/config`,
  }));
}
