import type { AppConfig, ConfigVersion, ConfigVersionContent, Deployment, PortConfig } from "@/lib/agent-types";
import { deployInput } from "@/lib/image-ref-core";

/**
 * What saving a change to an app's configuration does to the running container. Source of truth: the agent.
 *
 * - "live": read from the current configuration on every use, no container involved. agent/internal/deploy/proxied.go
 *   builds the proxy routes from `domains` in Reconcile, which agent/cmd/keelson-agent/main.go runs every 10 s and after
 *   a reload; `name`, `project` and `environment` are labels only (agent/internal/config/config.go, App.Project/Stage).
 *   One exception: whether an app has domains (or a `port`) decides if it is deployed blue/green behind
 *   the proxy (config.App.Proxied, used by buildSpec in deploy.go), so going from none to some, or back, is a "redeploy".
 * - "redeploy": baked into the container when a deployment creates it. buildSpec in agent/internal/deploy/deploy.go turns
 *   `image` (with the tag chosen by the deploy), `env`/`env_file` (App.Environment), `command`, `volumes`, `network`,
 *   `restart`, `stop_timeout`, `log` and `publish` into the container's spec; proxied.go publishes `port` and passes
 *   `port.host` through `port.env`. A running container never changes: only a new deployment applies them.
 * - "next-deploy": the settings of the deployment procedure itself, read from the configuration each time a deployment
 *   starts (deploy.go reads it once per deployment), so they apply from the next one without touching the running
 *   container: `health_path` (proxied.go probes it while the new container starts), `health_timeout`, `stable_after`,
 *   `drain`, `release` steps, `keep_images` (prune.go, after a deployment) and `build`.
 */
export type SaveImpact = "live" | "next-deploy" | "redeploy";

export const IMPACT_LABEL: Record<SaveImpact, string> = { redeploy: "Needs a deploy", "next-deploy": "Applies from the next deployment", live: "Applied live" };

const FIELD_IMPACT: Record<keyof AppConfig, SaveImpact> = {
  name: "live",
  project: "live",
  environment: "live",
  domains: "live",
  image: "redeploy",
  env_file: "redeploy",
  env: "redeploy",
  publish: "redeploy",
  volumes: "redeploy",
  network: "redeploy",
  restart: "redeploy",
  command: "redeploy",
  stop_timeout: "redeploy",
  port: "redeploy",
  deploy: "redeploy",
  log: "redeploy",
  health_path: "next-deploy",
  health_timeout: "next-deploy",
  stable_after: "next-deploy",
  drain: "next-deploy",
  soak: "next-deploy",
  verify: "next-deploy",
  release: "next-deploy",
  keep_images: "next-deploy",
  build: "next-deploy",
  previews: "live",
  database: "live",
  source: "live",
};

const FIELD_LABEL: Record<keyof AppConfig, string> = {
  name: "name",
  project: "project",
  environment: "environment",
  domains: "domains",
  image: "image repository",
  env_file: "environment file",
  env: "environment variables",
  publish: "published ports",
  volumes: "volumes",
  network: "network",
  restart: "restart policy",
  command: "command",
  stop_timeout: "stop timeout",
  port: "app port",
  deploy: "deploy strategy",
  log: "log settings",
  health_path: "health check path",
  health_timeout: "health timeout",
  stable_after: "stable-after delay",
  drain: "drain time",
  soak: "soak time",
  verify: "pages checked during the soak",
  release: "release steps",
  keep_images: "images kept",
  build: "build settings",
  previews: "previews",
  database: "managed database",
  source: "source repository",
};

/** Display order of the fields: the identity first, then the rest as the form lists them. */
const FIELDS = Object.keys(FIELD_IMPACT) as (keyof AppConfig)[];

/** Structural equality of two configuration values (JSON-shaped; key order does not matter). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface AppChanges {
  /** The fields that changed, by impact. */
  redeploy: (keyof AppConfig)[];
  nextDeploy: (keyof AppConfig)[];
  live: (keyof AppConfig)[];
}

/** `port` is a number (the container port), or a mapping of the container port, the two host ports and the variable. */
export function portParts(port: PortConfig | undefined): { container: number | undefined; host: number[] | undefined; env: string | undefined } {
  if (port === undefined || typeof port === "number") return { container: port, host: undefined, env: undefined };
  return { container: port.container, host: port.host, env: port.env };
}

/** config.App.Proxied: deployed blue/green behind the proxy: the declared strategy, else inferred from domains and port. */
function proxied(app: AppConfig): boolean {
  if (app.deploy?.strategy !== undefined) return app.deploy.strategy === "switch";
  const port = portParts(app.port);
  return (app.domains?.length ?? 0) > 0 || (port.container ?? 0) > 0 || (port.host?.length ?? 0) > 0;
}

/** Which fields differ between two versions of an app, grouped by what saving them does. A new app has nothing to deploy again. */
export function appChanges(before: AppConfig | undefined, after: AppConfig): AppChanges {
  const out: AppChanges = { redeploy: [], nextDeploy: [], live: [] };
  if (before === undefined) return out;
  for (const field of FIELDS) {
    if (same(before[field], after[field])) continue;
    let impact = FIELD_IMPACT[field];
    // The first or the last domain changes how the container is deployed (see SaveImpact).
    if (field === "domains" && proxied(before) !== proxied(after)) impact = "redeploy";
    (impact === "redeploy" ? out.redeploy : impact === "next-deploy" ? out.nextDeploy : out.live).push(field);
  }
  return out;
}

/** The strongest impact of a change, or null when nothing changed. */
export function saveImpact(changes: AppChanges): SaveImpact | null {
  if (changes.redeploy.length > 0) return "redeploy";
  if (changes.nextDeploy.length > 0) return "next-deploy";
  if (changes.live.length > 0) return "live";
  return null;
}

/** The fields in words, for "environment variables, command and volumes". */
export function listFields(fields: (keyof AppConfig)[]): string {
  const names = fields.map((f) => FIELD_LABEL[f]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a saved change of one app means for the user: whether the running version must be deployed again, and what changed. */
export interface SaveEffect {
  impact: SaveImpact | null;
  /** True when something changed that only a new deployment applies. */
  needsRedeploy: boolean;
  /** Human names of the changed fields, per impact: "environment variables", "command"... */
  redeploy: string[];
  nextDeploy: string[];
  live: string[];
}

export function saveEffect(before: AppConfig | undefined, after: AppConfig): SaveEffect {
  const changes = appChanges(before, after);
  const names = (fields: (keyof AppConfig)[]) => fields.map((f) => FIELD_LABEL[f]);
  const impact = saveImpact(changes);
  return { impact, needsRedeploy: impact === "redeploy", redeploy: names(changes.redeploy), nextDeploy: names(changes.nextDeploy), live: names(changes.live) };
}

/** `a, b and c` for human names that are already words. */
function andList(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The page of an app, opening its deploy dialog prefilled with the version that serves now (nothing prefilled when it has no exact tag or digest). */
export function redeployHref(serverId: string, app: string, servingImage: string): string {
  const base = `/servers/${serverId}/apps/${encodeURIComponent(app)}`;
  const input = deployInput(servingImage);
  return input === "" ? base : `${base}?deploy=${encodeURIComponent(input)}`;
}

/** What to tell the user once an app was saved. A notice that needs an action stays until dismissed. */
export interface SaveNotice {
  title: string;
  description?: string;
  action?: { label: string; href: string };
  /** Stays on screen until dismissed (a pending deploy must not vanish unseen). */
  persistent: boolean;
}

export function saveNotice(effect: SaveEffect, o: { serverId: string; app: string; servingImage: string }): SaveNotice {
  if (effect.needsRedeploy) {
    return {
      title: "Saved. Not running yet: deploy to apply",
      description: `${o.app}: ${andList(effect.redeploy)} only take effect in a new container. The running one keeps the old settings until it is deployed again.`,
      action: { label: "Deploy", href: redeployHref(o.serverId, o.app, o.servingImage) },
      persistent: true,
    };
  }
  if (effect.impact === "next-deploy") {
    return { title: "Saved. Applies from the next deployment", description: `${o.app}: ${andList(effect.nextDeploy)}. The running container does not change.`, persistent: false };
  }
  if (effect.impact === "live") return { title: "Saved. Applied live", description: `${o.app}: ${andList(effect.live)}.`, persistent: false };
  return { title: "Saved. Nothing changed", persistent: false };
}

export type ChangeKind = "added" | "removed" | "changed";

/** One line of a review: what was added, removed or changed. Secret values are never carried: only the kind. */
export interface ChangeRow {
  /** The item the row is about: a variable name, a setting path. */
  name?: string;
  kind: ChangeKind;
  before?: string;
  after?: string;
}

export interface FieldChange {
  field: keyof AppConfig;
  label: string;
  impact: SaveImpact;
  rows: ChangeRow[];
}

type Leaf = string | number | boolean;

/** The scalar leaves of a JSON-shaped value by path: `steps[0].run[1]`. */
function leaves(value: unknown, path: string, out: Map<string, string>): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaves(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value)) leaves(v, path === "" ? key : `${path}.${key}`, out);
    return;
  }
  out.set(path, String(value as Leaf));
}

function diffMaps(before: Map<string, string>, after: Map<string, string>, secret: boolean): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const name of names) {
    const b = before.get(name);
    const a = after.get(name);
    if (b === a) continue;
    const kind: ChangeKind = b === undefined ? "added" : a === undefined ? "removed" : "changed";
    rows.push(secret ? { name, kind } : { name, kind, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
  }
  return rows;
}

/** Fields whose list is read in order: reordering them is a change. */
const ORDERED = new Set<keyof AppConfig>(["command"]);

function rowsOf(field: keyof AppConfig, before: AppConfig | undefined, after: AppConfig): ChangeRow[] {
  const b = before?.[field];
  const a = after[field];
  if (field === "env") {
    // Values are secrets: a changed value is "changed", never shown. Hidden values passed back are unchanged.
    return diffMaps(new Map(Object.entries((b as Record<string, string> | undefined) ?? {})), new Map(Object.entries((a as Record<string, string> | undefined) ?? {})), true);
  }
  if (Array.isArray(b ?? a) && !ORDERED.has(field)) {
    const bs = ((b as string[] | undefined) ?? []).map(String);
    const as = ((a as string[] | undefined) ?? []).map(String);
    const rows: ChangeRow[] = [
      ...bs.filter((x) => !as.includes(x)).map((x): ChangeRow => ({ kind: "removed", before: x })),
      ...as.filter((x) => !bs.includes(x)).map((x): ChangeRow => ({ kind: "added", after: x })),
    ];
    if (rows.length > 0) return rows;
    return [{ kind: "changed", before: bs.join(", "), after: as.join(", ") }]; // the same items in another order
  }
  if (Array.isArray(b ?? a)) {
    const text = (v: unknown) => (Array.isArray(v) ? v.map(String).join(" ") : undefined);
    const bt = text(b);
    const at = text(a);
    return [{ kind: bt === undefined ? "added" : at === undefined ? "removed" : "changed", ...(bt !== undefined ? { before: bt } : {}), ...(at !== undefined ? { after: at } : {}) }];
  }
  if (typeof (b ?? a) === "object") {
    const bm = new Map<string, string>();
    const am = new Map<string, string>();
    leaves(b, "", bm);
    leaves(a, "", am);
    return diffMaps(bm, am, false);
  }
  return [{ kind: b === undefined ? "added" : a === undefined ? "removed" : "changed", ...(b !== undefined ? { before: String(b) } : {}), ...(a !== undefined ? { after: String(a) } : {}) }];
}

/**
 * The exact changes between two versions of an app, field by field, for the review before saving. Environment values
 * are never part of it (only which variable was added, removed or changed). A new app (`before` undefined) lists every
 * field it sets as added.
 */
export function reviewChanges(before: AppConfig | undefined, after: AppConfig): FieldChange[] {
  const changes = appChanges(before, after);
  const impactOf = (field: keyof AppConfig): SaveImpact => (changes.redeploy.includes(field) ? "redeploy" : changes.nextDeploy.includes(field) ? "next-deploy" : changes.live.includes(field) ? "live" : FIELD_IMPACT[field]);
  const out: FieldChange[] = [];
  for (const field of FIELDS) {
    if (before !== undefined && same(before[field], after[field])) continue;
    if (before === undefined && after[field] === undefined) continue;
    const rows = rowsOf(field, before, after);
    if (rows.length > 0) out.push({ field, label: FIELD_LABEL[field], impact: impactOf(field), rows });
  }
  return out;
}

/**
 * The text of one app inside the apps file, by top-level field. Used to tell whether the configuration of one app changed
 * between two versions of the whole file without a YAML parser: the agent writes the file with two-space indentation, the
 * items of `apps:` as "  - name: web" and their fields two columns further in.
 */
export function appBlock(content: string, name: string): Record<string, string> | null {
  const all = content.split("\n");
  const start = all.findIndex((l) => /^apps:\s*$/.test(l));
  if (start < 0) return null;
  let dashIndent = -1;
  let current: Record<string, string> | null = null;
  let key = "";
  const items: Record<string, string>[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const line = all[i];
    if (/^\S/.test(line) && !line.startsWith("- ") && !line.startsWith("#")) break; // the next top-level key
    const dash = /^(\s*)- (.*)$/.exec(line);
    if (dash && (dashIndent < 0 || dash[1].length === dashIndent)) {
      dashIndent = dash[1].length;
      current = {};
      items.push(current);
      key = "";
      // "- name: web": the dash stands where the field's indentation would be.
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(dash[2]);
      if (m) {
        key = m[1];
        current[key] = `${dash[2]}\n`;
      }
      continue;
    }
    if (current === null || line.trim() === "" || line.trim().startsWith("#")) continue;
    const field = new RegExp(`^ {${dashIndent + 2}}([A-Za-z_][A-Za-z0-9_]*):`).exec(line);
    if (field) key = field[1];
    if (key !== "") current[key] = `${current[key] ?? ""}${line.trim() === "" ? "" : line.slice(dashIndent + 2)}\n`;
  }
  return items.find((item) => /^name:\s*["']?(.+?)["']?\s*$/.exec(item.name ?? "")?.[1] === name) ?? null;
}

/** An app block's field holds something: `domains:` followed by items, or `port: 8080`, but not `domains: []`. */
function holds(block: Record<string, string>, key: string): boolean {
  return (block[key] ?? "").replace(/^[A-Za-z_][A-Za-z0-9_]*:\s*(\[\s*\])?/, "").trim() !== "";
}

/** config.App.Proxied, read from a block: domains, a port or host ports. */
function blockProxied(block: Record<string, string>): boolean {
  return holds(block, "domains") || holds(block, "port");
}

/**
 * True when what the running container was started from differs between two versions of the apps file: a field that
 * needs a redeploy (see SaveImpact), or an app that appeared or disappeared. Domains alone are live, except when the
 * app gains its first or loses its last (the container is then deployed another way). Fields that only the next
 * deployment reads (health check, release steps...) do not count: the running container is not built from them.
 * The versions the agent serves have their secrets replaced by `<hidden>`: a changed environment value shows no
 * difference in these blocks, so it is not seen here (see `secretsOnlyChanged`).
 */
export function containerConfigChanged(before: string, after: string, name: string): boolean {
  const a = appBlock(before, name);
  const b = appBlock(after, name);
  if (a === null || b === null) return a !== b;
  if (blockProxied(a) !== blockProxied(b)) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    // A key this dashboard does not know counts: better a badge too many than a change missed.
    if (key in FIELD_IMPACT && FIELD_IMPACT[key as keyof AppConfig] !== "redeploy") continue;
    if ((a[key] ?? "") !== (b[key] ?? "")) return true;
  }
  return false;
}

/**
 * Two versions of the file have different hashes but the same text once secrets are hidden: only a secret value
 * changed. The agent hides environment values, job headers and bodies and webhook URLs, and the version carries no
 * way to tell which one, so this counts as a change of the app (its environment is the commonest of them).
 */
export function secretsOnlyChanged(then: ConfigVersionContent, now: ConfigVersionContent): boolean {
  return then.hash !== now.hash && then.content === now.content;
}

/** Milliseconds of an agent timestamp (RFC 3339 with or without fractional seconds), NaN when unreadable. */
function ms(iso: string): number {
  return Date.parse(iso);
}

/**
 * The two versions of the apps file to compare to know whether an app's configuration changed since it was last deployed:
 * the one in force when that deployment started, and the latest. Null when nothing was saved since, when the history
 * does not reach back far enough to tell (there is no version from before the deployment: the first version, which is
 * only the file the agent found at its start, is never a change), or when a restore brought the same file back.
 */
export function versionsToCompare(versions: ConfigVersion[], deployedAt: string): { then: ConfigVersion; now: ConfigVersion } | null {
  const at = ms(deployedAt);
  if (Number.isNaN(at)) return null;
  const sorted = versions.filter((v) => !Number.isNaN(ms(v.at))).sort((a, b) => ms(b.at) - ms(a.at) || b.id - a.id);
  const now = sorted[0];
  if (now === undefined || ms(now.at) <= at) return null;
  const then = sorted.find((v) => ms(v.at) <= at);
  if (then === undefined || then.hash === now.hash) return null;
  return { then, now };
}

/** A version of the apps file that was saved after the version the running deployment started with. */
export interface ConfigChangedSince {
  /** When the last successful deployment of the app started: what it deployed is the configuration of that moment. */
  deployedAt: string;
  /** The version in force at that moment, and the latest: the two files to compare. */
  then: ConfigVersion;
  now: ConfigVersion;
}

/**
 * Whether versions of the configuration were saved since the app's last successful deployment, and which two to
 * compare. A deployment reads the configuration once when it starts (agent/internal/deploy/reload.go), so its time is
 * `started_at`, not `finished_at`. Failed, rolled-back and still-running deployments run nothing new and do not count.
 * Null when the deployments could not be loaded (never a reason to show a badge) or the app has no successful one.
 * This function sees versions of the whole file: whether the app's own section changed is decided by comparing the two
 * files' content (`containerConfigChanged`), because the agent lists no per-section history.
 */
export function configChangedSince(versions: ConfigVersion[], deployments: Deployment[] | null, appName: string): ConfigChangedSince | null {
  if (deployments === null) return null;
  let last: Deployment | undefined;
  for (const d of deployments) {
    if (d.app !== appName || d.status !== "succeeded" || Number.isNaN(ms(d.started_at))) continue;
    if (last === undefined || ms(d.started_at) > ms(last.started_at)) last = d;
  }
  if (last === undefined) return null;
  const pair = versionsToCompare(versions, last.started_at);
  return pair === null ? null : { deployedAt: last.started_at, ...pair };
}

/** The notice for an entity whose changes the agent always applies live (jobs, notifications, databases). */
export function liveNotice(subject: string): SaveNotice {
  return { title: `${subject} saved. Applied live`, persistent: false };
}

/** After a new app was added: it exists in the configuration only, nothing runs until its first deployment. */
export function createdNotice(o: { serverId: string; app: string }): SaveNotice {
  return { title: "Saved. Not running yet: deploy it to start", description: `${o.app} is in the configuration; choose the image tag to run.`, action: { label: "Deploy", href: redeployHref(o.serverId, o.app, "") }, persistent: true };
}
