import type { AppConfig, AppStatus } from "@/lib/agent-types";
import { portParts } from "@/lib/app-config-core";
import type { FileEntity, LabelEntity } from "@/lib/config-labels-core";
import { READ_ONLY_REASON } from "@/lib/gate-core";
import { canRunApps, type ServerKind } from "@/lib/machine-core";
import type { ServerRef } from "@/lib/projects-core";

// The lifecycle of a project, as plans: add an environment, rename the project. A plan decides everything (what is written,
// what is left out, what refuses) from the facts it is given and writes nothing; the dialogs show it before the operator
// confirms, and the server actions run the same function on fresh facts before they write. Pure.

/** What the agent accepts as the name of an app, a project or an environment (agent/internal/config: namePattern). */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const NAME_HINT = "Lowercase letters, digits, - and _; start with a letter or digit; up to 63 characters.";
const MAX_NAME = 63;

/** Why a project or environment name is refused, or null. */
export function nameIssue(kind: "project" | "environment", value: string): string | null {
  const name = value.trim();
  if (name === "") return `Enter a ${kind} name.`;
  if (!NAME_PATTERN.test(name)) return `"${name}" is not a valid ${kind} name. ${NAME_HINT}`;
  return null;
}

// ---- Servers to choose from --------------------------------------------------------------------------------------------

export interface ServerChoice {
  id: string;
  name: string;
  /** The project already has an app on it. */
  inProject: boolean;
  /** False when nothing can be added there; `reason` says why. */
  enabled: boolean;
  reason?: string;
}

/**
 * The servers an app of a project can be added on: the project's own first, then the others, each group by name. A server
 * that cannot deploy (no deploy secret in the dashboard) or does not serve traffic (a computer that connects out and runs no apps)
 * stays in the list, disabled, with its reason.
 */
export function serverChoices(servers: (ServerKind & { id: string; name: string; canDeploy: boolean })[], projectServerIds: string[]): ServerChoice[] {
  return servers
    .map((s): ServerChoice => {
      const inProject = projectServerIds.includes(s.id);
      if (!canRunApps(s)) return { id: s.id, name: s.name, inProject, enabled: false, reason: "Does not serve traffic" };
      if (!s.canDeploy) return { id: s.id, name: s.name, inProject, enabled: false, reason: READ_ONLY_REASON };
      return { id: s.id, name: s.name, inProject, enabled: true };
    })
    .sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.name.localeCompare(b.name));
}

/** The server an app can go to without asking, when only one server can take it. */
export function soleServer(choices: ServerChoice[]): ServerChoice | null {
  const enabled = choices.filter((c) => c.enabled);
  return enabled.length === 1 ? enabled[0] : null;
}

// ---- Add environment ---------------------------------------------------------------------------------------------------

/** The app an environment is copied from: where it runs, and its configuration when the server's file could be read. */
export interface CopySource {
  server: ServerRef;
  app: Pick<AppStatus, "name" | "image">;
  config: AppConfig | null;
}

/**
 * What copying leaves out, whatever the source says: variables (`env`, `env_file`; stored variables are never read), domains
 * (they must differ), and what belongs to this one app: its managed database (a copy would be another app's database), its
 * previews (a copy would answer on the same hostnames) and its source link (a copy would deploy on the same pushes).
 */
const NEVER_COPIED = ["env", "env_file", "domains", "database", "previews", "source"] as const satisfies readonly (keyof AppConfig)[];
/** Reasons to look at what was copied when the new app lands on the server the source runs on. */
const SHARED_ON_SAME_SERVER: { field: keyof AppConfig; what: string }[] = [
  { field: "publish", what: "published ports" },
  { field: "volumes", what: "volumes" },
];

export interface AddEnvironmentInput {
  project: string;
  environment: string;
  server: ServerRef;
  /** What to copy the configuration from; none starts from `image`. */
  from?: CopySource | null;
  /** The image repository of an environment that copies nothing. */
  image?: string;
  /** The environments the project has (an app without the label counts as `production`). */
  existingEnvironments: string[];
  /** The names of the apps already on `server`. */
  existingAppNames: string[];
}

/** A plan that can be carried out: the app to write, what was copied into it and what was left out. */
export interface AddEnvironmentPlanned {
  ok: true;
  appName: string;
  /** Written with the existing save of an app. */
  config: AppConfig;
  /** The fields of the source that were copied. */
  copied: (keyof AppConfig)[];
  /** What the source has that was NOT copied. */
  left: (keyof AppConfig)[];
  /** What to check before the first deploy. */
  warnings: string[];
}

export type AddEnvironmentPlan = { ok: false; reason: string } | AddEnvironmentPlanned;

/** `<project>-<environment>`, made unique on the server with a numeric suffix; null when no valid name fits. */
export function environmentAppName(project: string, environment: string, taken: string[]): string | null {
  const base = `${project}-${environment}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (name.length > MAX_NAME) return null;
    if (!taken.includes(name)) return name;
  }
  return null;
}

/**
 * The app that an environment of a project is: named `<project>-<environment>` (unique on the server), labelled with the
 * project and the environment. Refused when the project already has that environment, a name is not valid, the server cannot
 * deploy, or there is no image. Copying keeps the source's configuration (image, command, ports, volumes, health check,
 * build...) but never its variables or its domains: staging must not run with production's secrets, and two environments
 * cannot answer on the same hostname.
 */
export function planAddEnvironment(input: AddEnvironmentInput): AddEnvironmentPlan {
  const environment = input.environment.trim();
  const envIssue = nameIssue("environment", environment);
  if (envIssue !== null) return { ok: false, reason: envIssue };
  const projectIssue = nameIssue("project", input.project);
  if (projectIssue !== null) return { ok: false, reason: projectIssue };
  if (input.existingEnvironments.includes(environment)) return { ok: false, reason: `${input.project} already has an environment named ${environment}.` };
  if (!input.server.canDeploy) return { ok: false, reason: `${input.server.name} is a read-only server: nothing can be added there.` };

  const appName = environmentAppName(input.project, environment, input.existingAppNames);
  if (appName === null) {
    const tooLong = `${input.project}-${environment}`.length > MAX_NAME;
    return { ok: false, reason: tooLong ? `The app would be named ${input.project}-${environment}, which is longer than ${MAX_NAME} characters. Use a shorter environment name.` : `${input.server.name} has too many apps named ${input.project}-${environment}.` };
  }

  const source = input.from ?? null;
  const sourceConfig: Partial<AppConfig> = source === null ? {} : (source.config ?? { image: source.app.image });
  const image = (source === null ? (input.image ?? "") : (sourceConfig.image ?? source.app.image)).trim();
  if (image === "") return { ok: false, reason: "Enter the image of the app, or copy it from an environment." };
  if (/\s/.test(image)) return { ok: false, reason: "An image has no spaces." };

  const copied: (keyof AppConfig)[] = [];
  const left: (keyof AppConfig)[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sourceConfig) as [keyof AppConfig, unknown][]) {
    if (key === "name" || key === "project" || key === "environment" || key === "image" || value === undefined) continue;
    if ((NEVER_COPIED as readonly string[]).includes(key)) {
      if (!isEmpty(value)) left.push(key);
      continue;
    }
    if (isEmpty(value)) continue;
    rest[key] = structuredClone(value);
    copied.push(key);
  }
  if (source !== null) copied.unshift("image");

  const warnings: string[] = [];
  if (source !== null && source.server.id === input.server.id) {
    const shared = SHARED_ON_SAME_SERVER.filter((s) => copied.includes(s.field)).map((s) => s.what);
    if ((portParts(sourceConfig.port).host?.length ?? 0) > 0) shared.push("host ports");
    if (shared.length > 0) warnings.push(`It runs on ${input.server.name}, like ${source.app.name}: change its ${shared.join(", ")} before the first deploy, or both would use the same ones.`);
  }
  if (source !== null && source.config === null) warnings.push(`The configuration of ${source.server.name} could not be read: only the image was copied.`);

  const config: AppConfig = { name: appName, project: input.project, environment, image, ...(rest as Partial<AppConfig>) };
  return { ok: true, appName, config, copied, left, warnings };
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

// ---- Rename project ----------------------------------------------------------------------------------------------------

export type RenameKind = "app" | "job" | "database";

/** One entity of a server's configuration, as far as renaming a project cares. */
export interface RenameEntity {
  kind: RenameKind;
  name: string;
  /** The `project` label as written ("" when there is none: an app then belongs to the project named like itself). */
  label: string;
  /** It is declared in the apps file (not in a project file of its own), where the label can be written. */
  inAppsFile: boolean;
  /** Why the apps file cannot be edited at this entity (flow style, merge keys...). */
  unsupported?: string;
}

export interface RenameServerFacts {
  server: ServerRef;
  entities: RenameEntity[];
  /** Why the configuration cannot be read (no apps file, the agent did not answer); the server then cannot be written. */
  unreadable?: string;
}

export interface RenameChange {
  kind: RenameKind;
  name: string;
  /** The label is rewritten, or added to an app that had none (it belonged to the project named like itself). */
  write: "set" | "add";
}

export interface RenameServerPlan {
  server: ServerRef;
  changes: RenameChange[];
  apps: number;
  jobs: number;
  databases: number;
}

export interface RenameBlocker {
  serverId: string;
  serverName: string;
  reason: string;
}

export type RenamePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      from: string;
      to: string;
      /** Only the servers where something changes, each saved once. */
      servers: RenameServerPlan[];
      /** What stops the rename: while there is any, nothing may be written (a half-renamed project would be two). */
      blockers: RenameBlocker[];
      totals: { apps: number; jobs: number; databases: number };
    };

const KIND_SECTION = { app: "apps", job: "jobs", database: "databases" } as const;
const NOUN: Record<RenameKind, [string, string]> = { app: ["app", "apps"], job: ["job", "jobs"], database: ["database", "databases"] };

/** "2 apps, 1 job and 1 database". */
export function renameCountsText(c: { apps: number; jobs: number; databases: number }): string {
  const parts = ([["app", c.apps], ["job", c.jobs], ["database", c.databases]] as const).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${NOUN[kind][n === 1 ? 0 : 1]}`);
  if (parts.length === 0) return "nothing";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Everything that has to change for `from` to be called `to`: per server, each app whose effective project is `from` (its
 * label, or its own name when it has none, which then gets a label), and each job and database labelled `from`. Refuses a
 * name that is not valid, is the same, or is a project that exists. A server that cannot be written (read-only, unreadable,
 * or a configuration this editor cannot change safely) is a blocker, not a silent skip.
 */
export function planRenameProject(input: { from: string; to: string; facts: RenameServerFacts[]; existingProjects: string[] }): RenamePlan {
  const to = input.to.trim();
  const issue = nameIssue("project", to);
  if (issue !== null) return { ok: false, reason: issue };
  if (to === input.from) return { ok: false, reason: "That is already the name of the project." };
  if (input.existingProjects.includes(to)) return { ok: false, reason: `A project named ${to} exists already. Choose another name.` };

  const servers: RenameServerPlan[] = [];
  const blockers: RenameBlocker[] = [];
  for (const f of input.facts) {
    if (f.unreadable !== undefined) {
      blockers.push({ serverId: f.server.id, serverName: f.server.name, reason: f.unreadable });
      continue;
    }
    const changes: RenameChange[] = [];
    for (const e of f.entities) {
      if (e.kind === "app" ? (e.label || e.name) !== input.from : e.label !== input.from) continue;
      changes.push({ kind: e.kind, name: e.name, write: e.label === "" ? "add" : "set" });
      if (!e.inAppsFile) blockers.push({ serverId: f.server.id, serverName: f.server.name, reason: `${e.name} is declared in the project's own file, which is named after the project: a rename cannot move it.` });
      else if (e.unsupported !== undefined) blockers.push({ serverId: f.server.id, serverName: f.server.name, reason: `${e.name}: ${e.unsupported}. Edit the apps file by hand.` });
    }
    if (changes.length === 0) continue;
    if (!f.server.canDeploy) blockers.push({ serverId: f.server.id, serverName: f.server.name, reason: `${READ_ONLY_REASON}: its configuration cannot be changed from here.` });
    const count = (kind: RenameKind) => changes.filter((c) => c.kind === kind).length;
    servers.push({ server: f.server, changes, apps: count("app"), jobs: count("job"), databases: count("database") });
  }
  if (servers.length === 0 && blockers.length === 0) return { ok: false, reason: `Nothing belongs to ${input.from}: there is no app, job or database to rename.` };
  const total = (key: "apps" | "jobs" | "databases") => servers.reduce((n, s) => n + s[key], 0);
  return { ok: true, from: input.from, to, servers, blockers, totals: { apps: total("apps"), jobs: total("jobs"), databases: total("databases") } };
}

/** The entities of one server's plan, as the apps-file editor wants them (see lib/config-labels-core). */
export function labelEdits(server: RenameServerPlan): LabelEntity[] {
  return server.changes.map((c) => ({ section: KIND_SECTION[c.kind], name: c.name }));
}

/**
 * The facts of one server for a rename: every app, job and database of its configuration, and whether the apps file itself
 * declares it (a project file's entities are in the model, not in the file's text). `file` is the entities of the apps file as
 * read by `fileEntities`; `model` is what GET /v1/config answers.
 */
export function renameFacts(
  server: ServerRef,
  model: { apps?: { name: string; project?: string }[]; jobs?: { name: string; project?: string }[]; databases?: { name: string; project?: string }[] },
  file: FileEntity[],
): RenameServerFacts {
  const inFile = new Map(file.map((e) => [`${e.section}/${e.name}`, e]));
  const entities: RenameEntity[] = [];
  for (const kind of ["app", "job", "database"] as const) {
    const section = KIND_SECTION[kind];
    for (const e of model[section] ?? []) {
      const found = inFile.get(`${section}/${e.name}`);
      entities.push({ kind, name: e.name, label: found ? (found.label ?? "") : (e.project ?? ""), inAppsFile: found !== undefined, ...(found?.unsupported ? { unsupported: found.unsupported } : {}) });
    }
  }
  return { server, entities };
}
