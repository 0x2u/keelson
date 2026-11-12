/**
 * The steps of "New project", in order, with what each one needs injected: write the app into the agent's apps file,
 * set its variables on the agent (before the first build, so the build-time ones reach it), link it to the repository,
 * point its domain at the server (DNS), start its first build. A step that fails leaves the earlier ones as they are
 * (nothing is rolled back) and the outcome says exactly what is done and what is not. No database, no network.
 *
 * The variables' values pass through this module to the agent and nowhere else: never in an outcome, an audit line or a
 * message (what the agent says is cleaned of them again here).
 */

import type { AppConfig, ConfigDocument, ConfigIssue, EnvIssue, SaveOptions, SaveResult } from "@/lib/agent-types";
import { describeDns, type DnsResult } from "@/lib/dns-record-core";
import { AGENT_TOO_OLD_FOR_ENV, changeIssues, ENV_KEY, type EnvEdit } from "@/lib/env-core";
import { buildAppConfig, reviewContext, validateReview, type Review, type ReviewErrors, type ReviewInput } from "@/lib/repo-detect-core";

/** In the order they run. */
export const STEP_ORDER = ["config", "database", "env", "link", "dns", "build"] as const;
export type StepName = (typeof STEP_ORDER)[number];
/** The steps after the app is written: any of them can be retried, and a retry goes on to the ones after it. */
export type RetryStep = Exclude<StepName, "config">;

/** One variable as the wizard holds it until Create: the only place a value travels. */
export interface ProjectVar {
  key: string;
  value: string;
  /** Also a docker build argument: baked into the image. */
  build: boolean;
}

/** The variables as a client sent them, made safe: strings only, the last of a name wins, `build` only when exactly `true`. */
export function cleanVars(raw: unknown): ProjectVar[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, ProjectVar>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.key !== "string" || typeof r.value !== "string") continue;
    byKey.set(r.key, { key: r.key, value: r.value, build: r.build === true });
  }
  return [...byKey.values()];
}

/** The names of the variables, comma separated: all that is ever written to a log, an audit line or the page. */
export function varNames(vars: readonly ProjectVar[]): string {
  return vars.map((v) => v.key).join(", ");
}

export interface StepStatus {
  /** `todo`: not attempted, because a step before it failed or the form was refused. `skipped`: nothing to do, or left to the operator. */
  state: "done" | "failed" | "todo" | "skipped";
  detail: string;
}

/** What the operator chose for the DNS record of a domain. */
export interface DnsChoice {
  /** Keelson creates the record at Cloudflare; false = the operator creates it (nothing is sent anywhere). */
  create: boolean;
  /** Proxied through Cloudflare (hides the origin, works with HTTP-01) or DNS only (exposes the address). */
  proxied: boolean;
  /** The old value the operator confirmed replacing, as the conflict reported it. */
  confirmReplace?: string;
  /** Put a private address in the record anyway. */
  allowPrivate?: boolean;
}

/** The choice as a client sent it, made safe: only exactly `true` creates or allows, a proxied record is the default, a confirmation is text. */
export function cleanDnsChoice(raw: unknown): DnsChoice {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    create: r.create === true,
    proxied: r.proxied !== false,
    ...(typeof r.confirmReplace === "string" && r.confirmReplace !== "" ? { confirmReplace: r.confirmReplace.slice(0, 500) } : {}),
    ...(r.allowPrivate === true ? { allowPrivate: true } : {}),
  };
}

/** What the DNS step did: Cloudflare's result, or that the operator was left to create the record. */
export type DnsStep = DnsResult | { kind: "skipped"; message: string };

/** The DNS step stopped for a decision of the operator. */
export type DnsProblem = { kind: "conflict"; confirm: string; existing: { type: string; content: string; proxied: boolean }[] } | { kind: "private"; ip: string };

/** The variable the agent puts the URL of a database it creates in (its default; the wizard does not change it). */
export const DATABASE_ENV_KEY = "DATABASE_URL";

/** The database the agent created for the app. `backupKey` is a secret: returned once, never stored, logged or audited. */
export interface ProjectDatabase {
  name: string;
  envKey: string;
  /** False when the database already existed and the request only completed it. */
  created: boolean;
  /** The private key of the backups' encryption: shown to the operator once, who must keep it (nothing here or on the agent can recover it). */
  backupKey?: string;
  backupRecipient?: string;
}

/** What creating the app's database gave back: the database, or why it could not be made (never a secret). */
export type DatabaseCreation = { ok: true; database: ProjectDatabase } | { ok: false; error: string };

export interface ProjectOutcome {
  /** The form was refused before anything was written: the problems by field. */
  fieldErrors?: ReviewErrors;
  /** Variables the checks refused before anything was written, by name (never a value). */
  varIssues?: EnvIssue[];
  steps: Record<StepName, StepStatus>;
  /** Set when the DNS step failed for a reason the operator can decide on: a record that is not ours to overwrite, a private address. */
  dnsProblem?: DnsProblem;
  /** What the agent said about the configuration, verbatim: errors when it refused, warnings when it accepted. */
  issues: ConfigIssue[];
  /** The deployment of the first build, once it started. */
  deploymentId?: string;
  /** The database the agent created, once that step is done: the only place its backup key travels. */
  database?: ProjectDatabase;
  /** The step to retry: the first that failed after the app was written. Absent when everything is done or nothing was written. */
  retry?: RetryStep;
}

export interface ProjectDeps {
  /** The agent's configuration; null when it has no apps file. Throws what the agent's client throws. */
  config(): Promise<ConfigDocument | null>;
  saveApp(name: string, app: AppConfig, opts: SaveOptions): Promise<SaveResult>;
  /** Points the host name at the server (or says it is left to the operator). Never throws. */
  dns(hostname: string, choice: DnsChoice): Promise<DnsStep>;
  /** Whether the repository and branch can be read with the App: a message when not, so that nothing is written for them. */
  check(review: Review): Promise<string | null>;
  /** Whether the agent has the variables API (an older one answers its router's plain 404). */
  envSupported(): Promise<boolean>;
  /** Sets the variables of the app in one request. Never throws; the message it gives never holds a value. */
  setEnv(app: string, vars: ProjectVar[]): Promise<{ ok: true } | { ok: false; error: string; issues: EnvIssue[] }>;
  /** Stores the link of the app to the repository and the build modes. */
  link(review: Review): void;
  /** Starts the build of the branch head and says which deployment to watch. Never throws. */
  firstBuild(review: Review): Promise<{ ok: true; deploymentId: string } | { ok: false; error: string }>;
  /** Creates (or completes) a managed PostgreSQL database for the app and puts its URL in the app's variables. Never throws; the message never holds a secret. */
  createDatabase(app: string): Promise<DatabaseCreation>;
  audit(event: string, detail: string): void | Promise<void>;
  /** Says what went wrong with a call to the agent, for the operator (never a secret). */
  describe(err: unknown): string;
}

const TODO = (what: string): StepStatus => ({ state: "todo", detail: what });

export function outcome(steps: Partial<Record<StepName, StepStatus>>, extra: Partial<ProjectOutcome> = {}): ProjectOutcome {
  return {
    steps: { config: TODO("Not written."), database: TODO("Not done."), env: TODO("Not done."), link: TODO("Not done."), dns: TODO("Not done."), build: TODO("Not started."), ...steps },
    issues: [],
    ...extra,
  };
}

/** The names the agent reserves for the app's port: with a domain, and with a preset (the generated image reads its port from PORT). */
export function portKeysFor(preset: string, exposure: string): string[] {
  return exposure === "domain" || (preset !== "" && preset !== "dockerfile") ? ["PORT"] : [];
}

/** Text with every value of the variables taken out: a message from the agent or the network may echo one. */
export function scrubValues(text: string, vars: readonly ProjectVar[]): string {
  let out = text;
  for (const v of vars) if (v.value !== "") out = out.split(v.value).join("[redacted]");
  return out;
}

export function describeRefusal(result: Extract<SaveResult, { ok: false }>): string {
  switch (result.kind) {
    case "invalid":
      return result.message ?? "The agent refused the app as invalid.";
    case "changed":
      return "The agent's configuration was changed by someone else while you were filling in the form. Reload the page and review again.";
    case "busy":
      return result.message ?? "The agent is busy applying another change. Try again in a moment.";
    default:
      return result.message ?? "The agent asked for an acknowledgement this form cannot give. Edit the app in the configuration editor.";
  }
}

export async function recordFailure(deps: Pick<ProjectDeps, "audit">, event: string, detail: string): Promise<void> {
  try {
    await deps.audit(event, detail);
  } catch {
    // an audit that cannot be written never hides what the step did
  }
}

/** What the DNS step needs of an app: where it is exposed. */
export interface DnsTarget {
  exposure: { kind: "domain"; domain: string } | { kind: "local" | "none" };
}

/** The DNS step as it stands when a retry starts after it: what it did is not repeated, and what was left to the operator still is. */
export function dnsBefore(review: DnsTarget, choice: DnsChoice): StepStatus {
  if (review.exposure.kind !== "domain") return { state: "skipped", detail: review.exposure.kind === "none" ? "No domain." : "No domain: the app is on a local port." };
  return choice.create ? { state: "done", detail: "The DNS record was handled earlier." } : { state: "skipped", detail: "Left to you: create the record at your DNS provider." };
}

/** Runs the DNS step. It never throws and never blocks on a missing Cloudflare: that is a skipped step, with the values to create by hand. */
export async function runDns(review: DnsTarget, choice: DnsChoice, deps: Pick<ProjectDeps, "dns" | "audit">, where: string): Promise<{ step: StepStatus; problem?: DnsProblem }> {
  if (review.exposure.kind !== "domain") return { step: { state: "skipped", detail: review.exposure.kind === "none" ? "No domain." : "No domain: the app is on a local port." } };
  const hostname = review.exposure.domain;
  let result: DnsStep;
  try {
    result = await deps.dns(hostname, choice);
  } catch {
    result = { kind: "failed", message: "The DNS record could not be handled: something unexpected went wrong." };
  }
  switch (result.kind) {
    case "skipped":
      return { step: { state: "skipped", detail: result.message } };
    case "exists":
    case "created":
    case "replaced":
      return { step: { state: "done", detail: describeDns(result, hostname) } };
    default: {
      await recordFailure(deps, "dns_failed", `${where}: ${hostname}: ${describeDns(result, hostname)}`);
      const problem: DnsProblem | undefined =
        result.kind === "conflict" ? { kind: "conflict", confirm: result.confirm, existing: result.existing } : result.kind === "private" ? { kind: "private", ip: result.ip } : undefined;
      return { step: { state: "failed", detail: describeDns(result, hostname) }, ...(problem ? { problem } : {}) };
    }
  }
}

/** Sets the variables on the agent. Its failure says which names were refused and why, never a value. */
export async function runEnv(review: { name: string }, vars: ProjectVar[], deps: Pick<ProjectDeps, "setEnv" | "audit" | "describe">, where: string): Promise<{ step: StepStatus; issues?: EnvIssue[] }> {
  if (vars.length === 0) return { step: { state: "skipped", detail: "No variables." } };
  let result: Awaited<ReturnType<ProjectDeps["setEnv"]>>;
  try {
    result = await deps.setEnv(review.name, vars);
  } catch (err) {
    result = { ok: false, error: deps.describe(err), issues: [] };
  }
  const count = `${vars.length} variable${vars.length === 1 ? "" : "s"}`;
  if (!result.ok) {
    const error = scrubValues(result.error, vars);
    await recordFailure(deps, "env_set_failed", `${where}: ${review.name} (app): ${varNames(vars)}: ${error}`);
    const issues = result.issues.map((i) => ({ key: i.key, message: scrubValues(i.message, vars) }));
    return { step: { state: "failed", detail: `The variables could not be set: ${error}` }, issues };
  }
  const builds = vars.filter((v) => v.build);
  await deps.audit("env_set", `${where}: ${review.name} (app): ${varNames(vars)}${builds.length > 0 ? ` (build: ${varNames(builds)})` : ""}`);
  return { step: { state: "done", detail: `${count} set on the agent${builds.length > 0 ? `, ${builds.length} also as build arguments` : ""}.` } };
}

/** Creates the app's managed database, or completes it: idempotent on the agent. Its failure says why, never a secret. */
async function runDatabase(review: Review, deps: ProjectDeps, where: string): Promise<{ step: StepStatus; database?: ProjectDatabase }> {
  let result: DatabaseCreation;
  try {
    result = await deps.createDatabase(review.name);
  } catch (err) {
    result = { ok: false, error: deps.describe(err) };
  }
  if (!result.ok) {
    await recordFailure(deps, "database_create_failed", `${where}: ${review.name}: ${result.error}`);
    return { step: { state: "failed", detail: `The database could not be created: ${result.error}` } };
  }
  const db = result.database;
  // names only: the backup key is never audited
  await deps.audit("database_created", `${where}: ${review.name}: database ${db.name}, ${db.envKey}${db.created ? "" : " (it existed)"}`);
  return {
    step: {
      state: "done",
      detail: `${db.created ? "A PostgreSQL database was created" : "The PostgreSQL database already existed"} for ${review.name}: its URL is the ${db.envKey} variable, read when the app starts.`,
    },
    database: db,
  };
}

/** The steps after the app is written, from `from` on; the ones before it are reported as they stand. Stops at the first that fails. */
async function afterWrite(
  review: Review,
  from: RetryStep,
  deps: ProjectDeps,
  issues: ConfigIssue[],
  where: string,
  choice: DnsChoice,
  vars: ProjectVar[],
  db: boolean,
): Promise<ProjectOutcome> {
  const steps: Partial<Record<StepName, StepStatus>> = { config: { state: "done", detail: `${review.name} is in the server's configuration.` } };
  const target = `${review.name} -> ${review.branch}`;
  const reached = (name: RetryStep) => STEP_ORDER.indexOf(name) >= STEP_ORDER.indexOf(from);
  let database: ProjectDatabase | undefined;
  // every outcome carries the database result: its backup key is shown once, even when a later step fails
  const finish = (extra: Partial<ProjectOutcome> = {}) => outcome(steps, { issues, ...(database ? { database } : {}), ...extra });

  // 0. the database, before the variables and the build: its URL is a variable of the app, read when the app starts
  if (reached("database")) {
    if (db) {
      const ran = await runDatabase(review, deps, where);
      steps.database = ran.step;
      database = ran.database;
      if (ran.step.state === "failed") return finish({ retry: "database" });
    } else {
      steps.database = { state: "skipped", detail: "No database asked for." };
    }
  } else {
    steps.database = db ? { state: "done", detail: "The database was created earlier." } : { state: "skipped", detail: "No database asked for." };
  }

  // 1. the variables, before the build: the agent reads the build-time ones when it builds
  if (reached("env")) {
    const ran = await runEnv(review, vars, deps, where);
    steps.env = ran.step;
    if (ran.step.state === "failed") return finish({ retry: "env", ...(ran.issues && ran.issues.length > 0 ? { varIssues: ran.issues } : {}) });
  } else {
    steps.env = vars.length === 0 ? { state: "skipped", detail: "No variables." } : { state: "done", detail: "The variables were set earlier." };
  }

  // 2. the link to the repository and the build modes
  if (reached("link")) {
    try {
      deps.link(review);
    } catch {
      steps.link = { state: "failed", detail: "The link to the repository could not be stored in the dashboard." };
      return finish({ retry: "link" });
    }
    steps.link = { state: "done", detail: `Linked to the repository, branch ${review.branch}.` };
    await deps.audit("repo_linked", `${where}: ${target}`);
    await deps.audit("build_modes", `${where}: ${review.name}: push ${review.buildOnPush ? "on" : "off"}, previews ${review.previews ? "on" : "off"}`);
  } else {
    steps.link = { state: "done", detail: `Linked to the repository, branch ${review.branch}.` };
  }

  // 3. the domain's DNS record
  if (reached("dns")) {
    const ran = await runDns(review, choice, deps, where);
    steps.dns = ran.step;
    if (ran.step.state === "failed") return finish({ retry: "dns", ...(ran.problem ? { dnsProblem: ran.problem } : {}) });
  } else {
    steps.dns = dnsBefore(review, choice);
  }

  // 4. the first build
  const built = await deps.firstBuild(review);
  if (!built.ok) {
    await recordFailure(deps, "first_build_failed", `${where}: ${review.name}: ${built.error}`);
    steps.build = { state: "failed", detail: built.error };
    return finish({ retry: "build" });
  }
  const deploymentId = built.deploymentId;
  await deps.audit("first_build_started", `${where}: ${review.name}, deployment ${built.deploymentId}`);
  steps.build = { state: "done", detail: "The first build started." };
  return finish({ deploymentId });
}

/**
 * The variables' own problems (names, sizes, the agent's reserved names), found before anything is written. With a
 * database asked for, the variable that receives its URL is the agent's to set: a value typed for it would be overwritten.
 */
export function varProblems(review: Pick<ReviewInput, "preset" | "exposure">, vars: readonly ProjectVar[], db = false): EnvIssue[] {
  const edits: EnvEdit[] = vars.map((v) => ({ key: v.key, value: v.value, build: v.build }));
  const issues = changeIssues(edits, [], [], { portKeys: portKeysFor(review.preset, review.exposure) }).map((i) => ({ key: ENV_KEY.test(i.key) ? i.key : i.key.slice(0, 64), message: i.message }));
  if (db && vars.some((v) => v.key === DATABASE_ENV_KEY)) {
    issues.push({ key: DATABASE_ENV_KEY, message: "is set by the database Keelson creates for this app: remove it here, or turn the database off." });
  }
  return issues;
}

/**
 * Creates the project: checks the form against the agent's configuration, writes the app, sets its variables, links it,
 * points its domain, starts the first build. The app is never written over an existing one (the name is refused) and
 * the write carries the hash of the document that was read, so a change made meanwhile is refused by the agent.
 */
export async function createProject(repo: string, input: ReviewInput, where: string, deps: ProjectDeps, dns: DnsChoice, vars: ProjectVar[] = [], db = false): Promise<ProjectOutcome> {
  let doc: ConfigDocument | null;
  try {
    doc = await deps.config();
  } catch (err) {
    return outcome({ config: { state: "failed", detail: `The agent's configuration could not be read: ${deps.describe(err)}` } });
  }
  if (doc === null) return outcome({ config: { state: "failed", detail: "This server has no configuration to write to: it is read-only." } });
  if (doc.error) return outcome({ config: { state: "failed", detail: `The agent's configuration file is currently invalid: ${doc.error}` } });

  const checked = validateReview(input, reviewContext(doc.model));
  const problems = varProblems(input, vars, db);
  if (!checked.ok || problems.length > 0) return outcome({}, { ...(checked.ok ? {} : { fieldErrors: checked.errors }), ...(problems.length > 0 ? { varIssues: problems } : {}) });
  // The build gets a database only if one is created with the project.
  const review = { ...checked.review, buildDatabase: checked.review.buildDatabase && db };

  if (vars.length > 0) {
    let supported: boolean;
    try {
      supported = await deps.envSupported();
    } catch (err) {
      return outcome({ config: { state: "failed", detail: `Nothing was written. The agent could not be asked about variables: ${deps.describe(err)}` } });
    }
    if (!supported) return outcome({ config: { state: "failed", detail: `Nothing was written. ${AGENT_TOO_OLD_FOR_ENV}` } });
  }

  const unreadable = await deps.check(review);
  if (unreadable !== null) return outcome({ config: { state: "failed", detail: `Nothing was written. ${unreadable}` } });

  let saved: SaveResult;
  try {
    saved = await deps.saveApp(review.name, buildAppConfig(review), { base_hash: doc.hash, comment: `Created from ${repo} by the dashboard` });
  } catch (err) {
    return outcome({ config: { state: "failed", detail: `The agent could not be asked to write the app: ${deps.describe(err)}` } });
  }
  if (!saved.ok) return outcome({ config: { state: "failed", detail: describeRefusal(saved) } }, { issues: saved.issues });

  await deps.audit("app_created_from_repo", `${where}: ${review.name} <- ${repo}@${review.branch} (${review.preset === "dockerfile" ? "Dockerfile" : `${review.preset} preset`}${review.release !== "" ? ", release command" : ""})`);
  return afterWrite(review, "database", deps, saved.issues, where, dns, vars, db);
}

/**
 * Retries the step that failed after the app was written; it goes on to the steps after it. The app must still be in the
 * agent's configuration: nothing is written here. The variables come again from the browser: nothing kept them.
 */
export async function retryCreateProject(input: ReviewInput, from: RetryStep, where: string, deps: ProjectDeps, dns: DnsChoice, vars: ProjectVar[] = [], db = false): Promise<ProjectOutcome> {
  const written: StepStatus = { state: "done", detail: "The app was written earlier." };
  let doc: ConfigDocument | null;
  try {
    doc = await deps.config();
  } catch (err) {
    const failed: StepStatus = { state: "failed", detail: `The agent could not be read to retry: ${deps.describe(err)}` };
    const earlier: Partial<Record<StepName, StepStatus>> = { config: written };
    for (const name of STEP_ORDER.slice(1)) {
      if (name === from) {
        earlier[name] = failed;
        break;
      }
      earlier[name] = { state: "done", detail: "Handled earlier." };
    }
    return outcome(earlier, { retry: from });
  }
  const name = input.name.trim();
  if (doc === null || !(doc.model.apps ?? []).some((a) => a.name === name)) {
    return outcome({ config: { state: "failed", detail: `${name} is not in the agent's configuration any more: create it again.` } });
  }
  // The app is written: it must not clash with itself, and its own previews template still counts.
  const others = reviewContext({ ...doc.model, apps: (doc.model.apps ?? []).filter((a) => a.name !== name) });
  const checked = validateReview(input, { ...others, previewApps: reviewContext(doc.model).previewApps });
  const problems = varProblems(input, vars, db);
  if (!checked.ok || problems.length > 0) {
    return outcome({ config: written }, { ...(checked.ok ? {} : { fieldErrors: checked.errors }), ...(problems.length > 0 ? { varIssues: problems } : {}), retry: from });
  }
  return afterWrite(checked.review, from, deps, [], where, dns, vars, db);
}
