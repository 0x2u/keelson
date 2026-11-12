/**
 * The pure rules of the "New project" wizard: its steps, what a fresh form holds (nothing chosen), what a click on a
 * framework card sets, which problems keep the operator on a step, what the review says and how the variables of the
 * form are kept. No React, no network, no database.
 *
 * Variables: the values exist here only inside `ProjectVar`s the wizard holds in memory. Nothing in this module
 * returns a value as text for the page: the review lists names, counts and flags.
 */

import type { ServerStats } from "@/lib/server-stats-core";
import type { DockerfileCandidate } from "@/lib/github-detect";
import { parseDotenv } from "@/lib/dotenv-core";
import { keyIssue, suggestsBuild, valueIssue, type EnvRules } from "@/lib/env-core";
import { planWizard, type DnsSetup } from "@/lib/dns-record-core";
import { isHostname } from "@/lib/address-core";
import type { ProjectVar } from "@/lib/new-project-core";
import type { ProjectSuggestion } from "@/lib/project-suggest-core";
import { getPreset, isPresetId, visibleFields, type PresetField, type PresetId, type PresetOptions } from "@/lib/presets-core";
import {
  DEFAULT_BUILD_CPUS,
  DEFAULT_BUILD_MEMORY,
  DEFAULT_BUILD_TIMEOUT,
  validateReview,
  type ReviewContext,
  type ReviewErrorKey,
  type ReviewErrors,
  type ReviewInput,
} from "@/lib/repo-detect-core";

export const WIZARD_STEPS = [
  { id: "repository", label: "Repository" },
  { id: "framework", label: "Framework" },
  { id: "configure", label: "Configure" },
  { id: "variables", label: "Variables" },
  { id: "review", label: "Review" },
] as const;
export type StepId = (typeof WIZARD_STEPS)[number]["id"];

export const stepIndex = (id: StepId): number => WIZARD_STEPS.findIndex((s) => s.id === id);

/** A fresh form: nothing is chosen, and above all no framework. */
export function initialInput(o: { name: string; branch: string; hostPort: number; domains: boolean }): ReviewInput {
  return {
    name: o.name,
    branch: o.branch,
    preset: "",
    options: {},
    release: "",
    dockerfile: "Dockerfile",
    context: ".",
    port: "",
    exposure: o.domains ? "domain" : "local",
    domain: "",
    hostPort: String(o.hostPort),
    healthPath: "",
    memory: DEFAULT_BUILD_MEMORY,
    cpus: String(DEFAULT_BUILD_CPUS),
    timeout: DEFAULT_BUILD_TIMEOUT,
    buildHostNetwork: false,
    // when a database is created with the project, its build gets it too (the form says so, and it can be unticked)
    buildDatabase: true,
    envFile: "",
    buildOnPush: true,
    previews: false,
  };
}

/** What a click on a framework card sets: the preset, its default port and health path, no options (they show as placeholders). */
export function chooseFramework(input: ReviewInput, id: PresetId, candidate?: DockerfileCandidate): ReviewInput {
  const preset = getPreset(id);
  if (id === "dockerfile") {
    return {
      ...input,
      preset: id,
      options: {},
      port: candidate?.port != null ? String(candidate.port) : "",
      healthPath: "",
      ...(candidate ? { dockerfile: candidate.path, context: candidate.context } : {}),
    };
  }
  return { ...input, preset: id, options: {}, port: String(preset.defaultPort ?? ""), healthPath: preset.defaultHealthPath };
}

/** What a Dockerfile candidate sets once picked (its path, its context, the port it exposes). */
export function chooseCandidate(input: ReviewInput, c: DockerfileCandidate): ReviewInput {
  return { ...input, dockerfile: c.path, context: c.context, port: c.port === null ? "" : String(c.port) };
}

/** What a suggestion put into the form, kept so that it can be taken out again when another repository is chosen. */
export interface AppliedSuggestion {
  preset: string;
  release: string;
}

/**
 * Puts what a repository suggests into a form on which nothing was chosen yet: the framework card (with the first
 * Dockerfile found for the Dockerfile card) and the release command. A choice the operator already made is never
 * overwritten, so a suggestion that arrives late changes nothing they did.
 */
export function applySuggestion(input: ReviewInput, s: ProjectSuggestion, first?: DockerfileCandidate): { input: ReviewInput; applied: AppliedSuggestion | null } {
  if (input.preset !== "" || s.framework === null) return { input, applied: null };
  let next = chooseFramework(input, s.framework.id, s.framework.id === "dockerfile" ? first : undefined);
  const release = s.release !== null && next.release === "" ? s.release.command : "";
  if (release !== "") next = { ...next, release };
  return { input: next, applied: { preset: next.preset, release } };
}

/** Takes a suggestion out of the form again, only where the operator left it as it was put: what they changed stays. */
export function clearSuggestion(input: ReviewInput, applied: AppliedSuggestion): ReviewInput {
  return {
    ...input,
    ...(input.preset === applied.preset ? { preset: "", options: {}, port: "", healthPath: "" } : {}),
    ...(applied.release !== "" && input.release === applied.release ? { release: "" } : {}),
  };
}

/** One option set, dropping it when blank: a blank option means the preset's default. */
export function setOption(options: PresetOptions, field: PresetField, value: string | boolean): PresetOptions {
  const next: Record<string, string | boolean> = { ...options };
  if (value === "") delete next[field];
  else next[field] = value;
  return next as PresetOptions;
}

/**
 * The form as it is validated and sent: the health path only for a domain (the agent ignores it on a local port), previews
 * only where the agent has a template, and the Dockerfile fields and the options of the card that is not chosen left out.
 */
export function effectiveInput(input: ReviewInput, context: ReviewContext): ReviewInput {
  const previewsOffered = context.previewApps.includes(input.name.trim());
  const generated = isPresetId(input.preset) && input.preset !== "dockerfile" ? getPreset(input.preset) : null;
  return {
    ...input,
    // `ports` cannot go with `port`: on a local port a generated image listens on its default.
    port: generated !== null && input.exposure === "local" && generated.defaultPort !== null ? String(generated.defaultPort) : input.port,
    healthPath: input.exposure === "domain" ? input.healthPath : "",
    previews: input.previews && previewsOffered,
    options: input.preset === "dockerfile" ? {} : input.options,
  };
}

/** The problems of the form, by field, with the framework and Dockerfile problems told apart from the rest. */
export function formErrors(input: ReviewInput, context: ReviewContext): ReviewErrors {
  const checked = validateReview(effectiveInput(input, context), context);
  return checked.ok ? {} : checked.errors;
}

const FRAMEWORK_KEYS: readonly ReviewErrorKey[] = ["preset", "dockerfile", "context"];

/** The problems that keep the operator on a step. The review step has none of its own: it shows everything left. */
export function stepErrors(step: StepId, errors: ReviewErrors, preset: string): ReviewErrors {
  const frameworkKeys = preset === "dockerfile" ? FRAMEWORK_KEYS : (["preset"] as readonly ReviewErrorKey[]);
  const out: ReviewErrors = {};
  for (const [key, message] of Object.entries(errors) as [ReviewErrorKey, string][]) {
    const inFramework = frameworkKeys.includes(key);
    if (step === "framework" && inFramework) out[key] = message;
    else if (step === "configure" && !inFramework) out[key] = message;
    else if (step === "review") out[key] = message;
  }
  return out;
}

/** Whether a field of the configure step is inside the Advanced section (so it is opened when it has a problem). */
export function isAdvancedField(key: ReviewErrorKey): boolean {
  return key.startsWith("options.") || key === "memory" || key === "cpus" || key === "timeout" || key === "envFile";
}

// ---- the variables ----

export interface VariablesPaste {
  vars: ProjectVar[];
  /** Lines that could not be read, by number: never their content. */
  unreadable: { line: number; key?: string; reason: string }[];
  /** Names refused with the reason, and names that were already in the list and now have the pasted value. */
  refused: { key: string; reason: string }[];
  replaced: string[];
  repeated: string[];
  added: number;
}

/** Puts one variable in the list: a name that is there gets the new value (and keeps its build flag unless one is given). */
export function putVar(vars: readonly ProjectVar[], next: { key: string; value: string; build?: boolean }): ProjectVar[] {
  const found = vars.findIndex((v) => v.key === next.key);
  const var_: ProjectVar = { key: next.key, value: next.value, build: next.build ?? (found >= 0 ? vars[found].build : suggestsBuild(next.key)) };
  return found >= 0 ? vars.map((v, i) => (i === found ? var_ : v)) : [...vars, var_];
}

/** Adds what a pasted `.env` holds. Names the agent would refuse are reported and left out; build starts on for the names frameworks expose to the browser. */
export function pasteVars(vars: readonly ProjectVar[], text: string, rules: EnvRules = {}): VariablesPaste {
  const parsed = parseDotenv(text);
  let next = [...vars];
  const refused: VariablesPaste["refused"] = [];
  const replaced: string[] = [];
  let added = 0;
  for (const e of parsed.entries) {
    const issue = keyIssue(e.key, rules) ?? valueIssue(e.value);
    if (issue !== null) {
      refused.push({ key: e.key, reason: issue });
      continue;
    }
    if (next.some((v) => v.key === e.key)) replaced.push(e.key);
    else added++;
    next = putVar(next, { key: e.key, value: e.value });
  }
  return { vars: next, unreadable: parsed.invalid, refused, replaced, repeated: parsed.duplicates.map((d) => d.key), added };
}

/**
 * The variable typed in the "Add one variable" form but never added, as the list it would give; null when there is
 * nothing to keep (no name, no value, or one the agent would refuse: the form shows why). A value must be there:
 * a name alone is a half-typed field, not a variable with an empty value.
 */
export function pendingVariable(vars: readonly ProjectVar[], key: string, value: string, rules: EnvRules = {}): ProjectVar[] | null {
  const name = key.trim();
  if (name === "" || value === "") return null;
  if (keyIssue(name, rules) !== null || valueIssue(value) !== null) return null;
  return putVar(vars, { key: name, value });
}

export function removeVar(vars: readonly ProjectVar[], key: string): ProjectVar[] {
  return vars.filter((v) => v.key !== key);
}

export function setVarBuild(vars: readonly ProjectVar[], key: string, build: boolean): ProjectVar[] {
  return vars.map((v) => (v.key === key ? { ...v, build } : v));
}

// ---- the review ----

export interface ReviewLine {
  label: string;
  value: string;
}

/** What the review says about the DNS record: the plan as it stands, in words. */
export function dnsSummary(input: Pick<ReviewInput, "exposure" | "domain">, setup: DnsSetup, create: boolean, proxied: boolean): string | null {
  if (input.exposure !== "domain") return null;
  const domain = input.domain.trim().toLowerCase();
  if (!isHostname(domain)) return null;
  const plan = planWizard(domain, setup);
  if (plan.kind === "cloudflare" && create) return `Keelson creates ${plan.type} ${domain} → ${plan.ip} at Cloudflare (zone ${plan.zone}), ${proxied ? "proxied" : "DNS only"}.`;
  if (plan.kind === "cloudflare") return `You create ${plan.type} ${domain} → ${plan.ip} yourself: Keelson does not touch Cloudflare.`;
  return plan.record === null ? plan.message : `You create ${plan.record.type} ${plan.record.name} → ${plan.record.content} at your DNS provider. ${plan.message}`;
}

/** The options that differ from a blank one, as `label: value`, in the registry's order. */
export function optionLines(preset: PresetId, options: PresetOptions): ReviewLine[] {
  if (preset === "dockerfile") return [];
  const labels: Record<PresetField, string> = {
    context: "Directory",
    install: "Install command",
    build_command: "Build command",
    start: "Start command",
    output_dir: "Output directory",
    node: "Node.js version",
    spa: "Single-page fallback",
    standalone: "Standalone output",
    dockerfile: "Dockerfile",
    target: "Stage",
  };
  const out: ReviewLine[] = [];
  const shown = visibleFields(preset, options);
  for (const field of shown) {
    const v = (options as Record<string, unknown>)[field];
    if (typeof v === "string" && v.trim() !== "") out.push({ label: labels[field], value: v.trim() });
    else if (typeof v === "boolean" && v !== (getPreset(preset).defaults[field as "spa" | "standalone"] ?? false)) out.push({ label: labels[field], value: v ? "on" : "off" });
  }
  return out;
}

/** The names of the variables with their build flag, and nothing else. */
export function variableLines(vars: readonly ProjectVar[]): ReviewLine[] {
  return vars.map((v) => ({ label: v.key, value: v.build ? "available at build time" : "runtime only" }));
}

// ---- what the page knows about each server ----

/** What the wizard needs from one server, read when the page is rendered: nothing secret. */
export interface ProjectServer {
  id: string;
  name: string;
  /** Names, domains and ports the agent's configuration holds, its proxy kind and its previews templates. */
  context: ReviewContext;
  /** The first free local port. */
  hostPort: number;
  /** The server's address and the Cloudflare connection, for the DNS plan. */
  dns: DnsSetup;
  /** The agent has the variables API. */
  envSupported: boolean;
  /** The agent has the managed PostgreSQL API (an older one answers its router's plain 404). */
  databaseSupported: boolean;
  /** The domain new projects get a host name under (`<project>.<appsDomain>`), when the operator set one for this server. */
  appsDomain: string | null;
  /** Its CPU, memory and disk now, to tell servers apart when choosing one. */
  stats: ServerStats;
}

/**
 * The address a new project gets under the server's apps domain: `<name>.<domain>`. Empty without a domain, or when the
 * name makes no host name (an app name may hold underscores, a host name may not: they become dashes).
 */
export function defaultDomain(name: string, appsDomain: string | null): string {
  const label = name.trim().toLowerCase().replace(/_/g, "-");
  if (appsDomain === null || label === "") return "";
  const host = `${label}.${appsDomain}`;
  return isHostname(host) ? host : "";
}

/**
 * The form with its domain filled in from the server's apps domain: `<name>.<apps domain>`, for a server that serves
 * domains. Left as it is once the operator typed a domain (`edited`), on a server with no apps domain, or on one that
 * cannot serve domains.
 */
export function withDefaultDomain(input: ReviewInput, server: Pick<ProjectServer, "appsDomain" | "context">, edited: boolean): ReviewInput {
  if (edited || server.appsDomain === null || server.context.proxy !== "caddy") return input;
  return { ...input, domain: defaultDomain(input.name, server.appsDomain) };
}

/**
 * The context to check the form against once the app is written. The agent's configuration then holds the app, so its
 * name, domain and port would be reported as taken by itself: nothing is unique to check any more.
 */
export function writtenContext(context: ReviewContext): ReviewContext {
  return { ...context, existingNames: [], usedDomains: [], usedHostPorts: [] };
}
