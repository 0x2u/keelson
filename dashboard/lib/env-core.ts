import type { DotenvParse } from "@/lib/dotenv-core";
import type { AppConfig, Deployment, EnvChange, EnvIssue, EnvScope, EnvVar } from "@/lib/agent-types";
import { portParts, redeployHref, type SaveNotice } from "@/lib/app-config-core";

// The rules of managed environment variables as the dashboard applies them before asking the agent, and the pure
// decisions of the page: what an import would do, what to tell after a save, whether the running version is behind.
// The agent is the authority (it checks everything again); these mirror its rules so a mistake is caught in the form.
// Nothing here ever keeps or returns a value other than the one the caller passes in and gets back unchanged.

/** The answer when an agent has no managed-variables routes. */
export const AGENT_TOO_OLD_FOR_ENV = "This agent is too old to manage variables. Update it from the server's page, then try again.";

/** A name the agent accepts: letters, digits and _, not starting with a digit, at most 128 characters. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_VALUE_BYTES = 32 * 1024;
export const MAX_SCOPE_BYTES = 256 * 1024;
export const MAX_KEYS = 200;

/** Names the agent sets for the container itself. */
const RESERVED = new Set(["PATH", "HOME", "HOSTNAME"]);

/** The two scopes of an app's variables, labelled for the environment the app is in (`production`, `staging`...): its own variables carry the environment's name, the previews' are "Previews". */
export function scopeLabels(environment: string): { scope: EnvScope; label: string }[] {
  return [
    { scope: "app", label: environment },
    { scope: "preview", label: "Previews" },
  ];
}

export const scopeLabel = (scope: EnvScope, environment: string): string => (scope === "app" ? environment : "Previews");

/** `?scope=preview` selects the preview tab; anything else is the app's own. */
export function scopeOf(raw: string | string[] | undefined): EnvScope {
  return (Array.isArray(raw) ? raw[0] : raw) === "preview" ? "preview" : "app";
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** What the checks need to know of the app: the names the agent sets itself because the app has `port:` (PORT, and `port.env` when set). */
export interface EnvRules {
  portKeys?: string[];
}

/** The names the agent sets for an app's port, from its configuration; none when the app has no `port:`. */
export function portKeysOf(app: Pick<AppConfig, "port"> | undefined): string[] {
  if (app?.port === undefined) return [];
  const env = portParts(app.port).env;
  return env ? ["PORT", env] : ["PORT"];
}

/** Why a name is refused, or null. */
export function keyIssue(key: string, o: EnvRules = {}): string | null {
  if (key === "") return "Enter a name.";
  if (!ENV_KEY.test(key)) return "A name uses letters, digits and _, does not start with a digit, and has at most 128 characters.";
  if (RESERVED.has(key) || key.startsWith("KEELSON_")) return `${key} is set by Keelson for the container and cannot be overridden.`;
  if (o.portKeys?.includes(key)) return `${key} is set by Keelson from the app's port: and cannot be overridden.`;
  return null;
}

/** Why a value is refused, or null. An empty value is allowed. */
export function valueIssue(value: string): string | null {
  if (value.includes("\0")) return "A value cannot contain a NUL character.";
  if (byteLength(value) > MAX_VALUE_BYTES) return "A value can be at most 32 KiB.";
  return null;
}

/** Names of variables that are read by the browser or at build time by convention: they end up in the image. */
export function suggestsBuild(key: string): boolean {
  return /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(key);
}

/** A name that looks like it holds a secret. Only a hint for the warning: the agent never guesses. */
export function looksSecret(key: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH)/i.test(key);
}

/** The warning shown with "Available at build time". */
export const BUILD_WARNING =
  "A build-time value is passed to docker build as a build argument: it is baked into the image and visible in its history to anyone who can pull it. Never use it for a secret.";

export interface EnvEdit {
  key: string;
  /** The new value; null keeps the stored one (only the build flag changes). */
  value: string | null;
  build: boolean;
}

/**
 * Checks a whole change before it is sent: every issue is for one key (or "" for the change as a whole). `existing` are the
 * names already stored, which count toward the limit of keys.
 */
export function changeIssues(
  edits: EnvEdit[],
  unset: string[],
  existing: string[],
  o: EnvRules = {},
): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const names = new Set(existing);
  let bytes = 0;
  for (const e of edits) {
    const key = keyIssue(e.key, o);
    if (key !== null) issues.push({ key: e.key, message: key });
    const value = e.value === null ? null : valueIssue(e.value);
    if (value !== null) issues.push({ key: e.key, message: value });
    bytes += e.value === null ? 0 : byteLength(e.value);
    names.add(e.key);
  }
  for (const k of unset) {
    if (!ENV_KEY.test(k)) issues.push({ key: k.slice(0, 64), message: "Not a valid name." });
    names.delete(k);
  }
  if (names.size > MAX_KEYS) issues.push({ key: "", message: `A scope can hold at most ${MAX_KEYS} variables.` });
  if (bytes > MAX_SCOPE_BYTES) issues.push({ key: "", message: "The values of a scope can take at most 256 KiB in all." });
  return issues;
}

/**
 * The request for the agent from the edits (the last edit of a name wins) and the names to remove. The agent takes `build` as
 * the exact list of build arguments after the change, so it starts from the ones stored now: leaving one out would drop it.
 */
export function toChange(scope: EnvScope, edits: EnvEdit[], unset: string[], stored: EnvVar[]): EnvChange {
  const set: Record<string, string> = {};
  const build = new Set(stored.filter((v) => v.build).map((v) => v.key));
  for (const k of unset) build.delete(k);
  for (const e of edits) {
    if (e.value !== null) set[e.key] = e.value;
    if (e.build) build.add(e.key);
    else build.delete(e.key);
  }
  return { scope, set, build: [...build], ...(unset.length > 0 ? { unset } : {}) };
}

export type ImportStatus = "new" | "replace" | "invalid";

export interface ImportRow {
  key: string;
  status: ImportStatus;
  /** Why a row cannot be imported. */
  issue?: string;
  /** Whether the value is also a build argument, to start from: the names the frameworks expose to the browser. */
  build: boolean;
  /** The name has a value stored already (the import replaces it, never showing it). */
  replaces: boolean;
}

export interface ImportReview {
  rows: ImportRow[];
  /** Lines of the file that could not be read, with the reason (never their content). */
  unreadable: { line: number; key?: string; reason: string }[];
  /** Names given more than once: the last value is used. */
  repeated: { key: string; lines: number[] }[];
  /** Problems with the import as a whole. */
  issues: EnvIssue[];
}

/** What importing a parsed .env would do: which names are new, which replace a stored value, which cannot be imported. */
export function reviewImport(parse: DotenvParse, existing: EnvVar[], o: EnvRules = {}): ImportReview {
  const stored = new Set(existing.map((v) => v.key));
  const rows: ImportRow[] = parse.entries.map((e) => {
    const issue = keyIssue(e.key, o) ?? valueIssue(e.value);
    return {
      key: e.key,
      status: issue !== null ? "invalid" : stored.has(e.key) ? "replace" : "new",
      ...(issue !== null ? { issue } : {}),
      build: suggestsBuild(e.key),
      replaces: stored.has(e.key),
    };
  });
  const usable = parse.entries.filter((e, i) => rows[i].status !== "invalid");
  const issues = changeIssues(
    usable.map((e) => ({ key: e.key, value: e.value, build: false })),
    [],
    [...stored],
    o,
  ).filter((i) => i.key === "");
  return { rows, unreadable: parse.invalid, repeated: parse.duplicates, issues };
}

/** The deployments the badge compares with: the last one that is serving or about to serve, by start time. */
export function envPending(app: { env_changed_at?: string }, deployments: Deployment[] | null): { changedAt: string } | null {
  const changed = app.env_changed_at;
  if (!changed || deployments === null) return null;
  const at = Date.parse(changed);
  if (Number.isNaN(at)) return null;
  // A deployment reads the variables when it starts: one that started after the change has them (a running one will).
  const taken = deployments.filter((d) => d.status === "succeeded" || d.status === "running");
  if (taken.length === 0) return null;
  const latest = Math.max(...taken.map((d) => Date.parse(d.started_at)));
  return at > latest ? { changedAt: changed } : null;
}

/** What to tell once variables were saved. */
export function envSavedNotice(scope: EnvScope, o: { serverId: string; app: string; servingImage: string; buildKeys: number }): SaveNotice {
  const build = o.buildKeys > 0 ? " Build-time values reach the image only when it is built again, not when it is deployed again." : "";
  if (scope === "preview") {
    return {
      title: "Saved. Applies to previews deployed from now",
      description: `${o.app}: the previews that are running keep their variables until they are deployed again.${build}`,
      persistent: false,
    };
  }
  return {
    title: "Saved. Not running yet: deploy to apply",
    description: `${o.app}: the running container keeps the old variables until it is deployed again.${build}`,
    action: { label: "Deploy", href: redeployHref(o.serverId, o.app, o.servingImage) },
    persistent: true,
  };
}

/** "Overrides env_file" / "Overrides env": the managed value wins over the same name in the apps file. */
export function shadowLabel(shadows: EnvVar["shadows"]): string | null {
  if (shadows === "env_file") return "Overrides env_file";
  if (shadows === "env") return "Overrides env";
  return null;
}

/** The most recent change of a scope: the agent's `last_changed`, else the latest of the variables. */
export function lastChanged(view: { vars: EnvVar[]; last_changed?: string | null }): string | null {
  if (view.last_changed) return view.last_changed;
  const times = view.vars.map((v) => v.updated_at).filter((t) => t !== "");
  return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}
