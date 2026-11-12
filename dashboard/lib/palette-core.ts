import { hubTabHref, type ProjectTabId } from "@/lib/nav-core";
import { addAppHref, addEnvironmentHref } from "@/lib/project-actions-core";
import { notificationsHref } from "@/lib/redirects-core";
import { GO_SHORTCUTS } from "@/lib/shortcuts-core";

// The command palette's brain: what can be jumped to or started from it (the registry), how a query ranks it, and what is
// remembered between uses. Pure. The palette itself never changes anything: an action is a link to the page that asks, in a
// dialog, with the thing already chosen.

export type PaletteGroup = "Recent" | "Actions" | "Go to" | "Projects" | "Servers" | "Apps" | "Domains" | "Jobs" | "Databases" | "Containers" | "Preferences";

/** The order groups appear in when nothing says otherwise. */
export const GROUP_ORDER: PaletteGroup[] = ["Recent", "Actions", "Go to", "Projects", "Servers", "Apps", "Domains", "Jobs", "Databases", "Containers", "Preferences"];

/** Things the palette does on the page itself, without leaving it. */
export type PaletteCommand = "theme-light" | "theme-dark" | "theme-system" | "sign-out" | "shortcuts";

/** Where an entry belongs, to put what concerns the page you are on first. */
export interface PaletteScope {
  server?: string;
  app?: string;
  job?: string;
  container?: string;
  project?: string;
}

export interface PaletteEntry {
  /** Stable across loads: what "recent" remembers. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Where it lives, in a few words. */
  hint?: string;
  /** More words that find it. */
  keywords?: string;
  href?: string;
  command?: PaletteCommand;
  /** The keys that go there from anywhere: ["g", "h"]. */
  shortcut?: string[];
  scope?: PaletteScope;
  /** Of an entry shown under "Recent": the group it belongs to. */
  origin?: PaletteGroup;
}

// ---- What the server tells the palette ------------------------------------------------------------------------------------

interface OnServer {
  server: { id: string; name: string; canDeploy: boolean };
}

/** The fleet in the shape the palette needs: bounded lists, no secrets. */
export interface PaletteIndex {
  servers: { id: string; name: string; url: string; canDeploy: boolean }[];
  /** `project` is the app's project (its own name when it has none). */
  apps: (OnServer & { name: string; project: string; environment?: string; image: string; serving: boolean; deployed: boolean })[];
  /** `project` of a job, a database or a domain: the project that owns it, absent when none does. */
  jobs: (OnServer & { name: string; project?: string; schedule: string; running: boolean; paused: boolean })[];
  databases: (OnServer & { name: string; project?: string; target: string })[];
  containers: (OnServer & { name: string; running: boolean; managed: boolean; /** The app it belongs to (its keelson.app label). */ app?: string })[];
  domains: (OnServer & { hostname: string; project?: string; label: string })[];
  /** Some list was cut at its bound: on a large fleet, search narrower. */
  truncated: boolean;
}

/** The most each list of the index holds. */
export const INDEX_LIMITS = { apps: 300, jobs: 200, databases: 100, containers: 400, domains: 300 } as const;

export const emptyIndex = (): PaletteIndex => ({ servers: [], apps: [], jobs: [], databases: [], containers: [], domains: [], truncated: false });

const enc = encodeURIComponent;

/** Where each action goes: the page of the thing, with a query parameter that opens the dialog that asks. Never a request that changes anything. */
export const ACTION_HREFS = {
  deploy: (server: string, app: string) => `/servers/${server}/apps/${enc(app)}?deploy=`,
  rollback: (server: string, app: string) => `/servers/${server}/apps/${enc(app)}?rollback=1`,
  runJob: (server: string, job: string) => `/servers/${server}/jobs/${enc(job)}?runnow=1`,
  restart: (server: string, container: string) => `/servers/${server}/containers/${enc(container)}?restart=1`,
  start: (server: string, container: string) => `/servers/${server}/containers/${enc(container)}?start=1`,
} as const;

/** The pages every operator goes to, with the shortcut that goes there from anywhere. */
export const GO_TO: { id: string; label: string; href: string; keywords: string }[] = [
  { id: "home", label: "Home", href: "/", keywords: "overview dashboard attention" },
  { id: "projects", label: "Projects", href: "/projects", keywords: "environments production staging" },
  { id: "servers", label: "Servers", href: "/servers", keywords: "agents hosts machines" },
  { id: "databases", label: "Databases", href: "/databases", keywords: "postgres backups restore" },
  { id: "jobs", label: "Jobs", href: "/jobs", keywords: "scheduled cron tasks" },
  { id: "activity", label: "Activity", href: "/activity", keywords: "history deployments audit log events" },
  { id: "settings", label: "Settings", href: "/settings", keywords: "preferences account" },
  { id: "security", label: "Security", href: "/settings/security", keywords: "password passkey authenticator sessions two-factor 2fa" },
  { id: "api-tokens", label: "API tokens", href: "/settings/api-tokens", keywords: "keys ci github action mcp" },
  { id: "integrations", label: "Integrations", href: "/settings/integrations", keywords: "github cloudflare dns webhook" },
  { id: "notifications", label: "Notifications", href: notificationsHref(), keywords: "alerts email webhook slack" },
  { id: "add-server", label: "Add server", href: "/servers/new", keywords: "connect new agent install enrol" },
  { id: "new-project", label: "New project", href: "/projects/new", keywords: "add app repository repo github create deploy framework nextjs" },
];

const COMMANDS: { id: string; command: PaletteCommand; label: string; keywords: string; shortcut?: string[] }[] = [
  { id: "shortcuts", command: "shortcuts", label: "Keyboard shortcuts", keywords: "keys help hotkeys", shortcut: ["?"] },
  { id: "theme-light", command: "theme-light", label: "Light theme", keywords: "appearance" },
  { id: "theme-dark", command: "theme-dark", label: "Dark theme", keywords: "appearance" },
  { id: "theme-system", command: "theme-system", label: "Follow the system theme", keywords: "appearance auto" },
  { id: "sign-out", command: "sign-out", label: "Sign out", keywords: "logout" },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PROJECT_TAB_PREFIX = "project-tab:";

/** The tabs of a project's hub the palette jumps to (the overview is the project itself), with the words that find each. */
const PROJECT_TAB_ENTRIES: { id: Exclude<ProjectTabId, "overview">; label: string; keywords: string }[] = [
  { id: "apps", label: "Apps", keywords: "apps environments deploy production staging" },
  { id: "jobs", label: "Jobs", keywords: "jobs scheduled cron tasks backups" },
  { id: "databases", label: "Databases", keywords: "databases postgres backups restore" },
  { id: "domains", label: "Domains", keywords: "domains hostnames proxy dns routes" },
  { id: "variables", label: "Variables", keywords: "variables environment env secrets" },
  { id: "source", label: "Source", keywords: "source repository git github build branch" },
  { id: "readiness", label: "Readiness", keywords: "readiness trust checklist backups restore test key alerts health rollback" },
  { id: "config", label: "Configuration", keywords: "configuration config yaml definition" },
];

/** The project the page is about: the project of the page itself, else of the app or job it is on (the index knows who owns what). */
function projectInContext(index: PaletteIndex, context: PaletteScope): string | undefined {
  if (context.project !== undefined) return context.project;
  if (context.server === undefined) return undefined;
  if (context.app !== undefined) return index.apps.find((a) => a.server.id === context.server && a.name === context.app)?.project;
  if (context.job !== undefined) return index.jobs.find((j) => j.server.id === context.server && j.name === context.job)?.project;
  return undefined;
}

/** Everything the palette can offer, from the fleet: pages, things, and the actions that apply to them (`context`: the page you are on, for the create actions of its project). */
export function buildRegistry(index: PaletteIndex, context: PaletteScope = {}): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const g of GO_TO) {
    const key = GO_SHORTCUTS.find((s) => s.href === g.href)?.key;
    out.push({ id: `go:${g.id}`, group: "Go to", label: g.label, href: g.href, keywords: g.keywords, shortcut: key === undefined ? undefined : ["g", key] });
  }

  // The projects: what apps, jobs and databases name. The servers are kept in order of first mention.
  const projects = new Map<string, { apps: number; servers: Map<string, { id: string; canDeploy: boolean }> }>();
  const project = (name: string, server: { id: string; canDeploy: boolean }) => {
    const p = projects.get(name) ?? { apps: 0, servers: new Map() };
    p.servers.set(server.id, server);
    projects.set(name, p);
    return p;
  };
  for (const a of index.apps) project(a.project, a.server).apps++;
  for (const j of index.jobs) if (j.project !== undefined) project(j.project, j.server);
  for (const d of index.databases) if (d.project !== undefined) project(d.project, d.server);

  out.push({ id: "action:new-project", group: "Actions", label: "New project", keywords: "create repository repo github deploy framework", href: "/projects/new" });
  const current = projectInContext(index, context);
  if (current !== undefined) {
    const scope = { project: current };
    out.push(
      { id: `action:add-app:${current}`, group: "Actions", label: `Add app to ${current}`, keywords: "create new deploy service", href: addAppHref(current), scope },
      { id: `action:add-environment:${current}`, group: "Actions", label: `Add environment to ${current}`, keywords: "create new staging production preview", href: addEnvironmentHref(current), scope },
    );
  }
  // A job or a database is added on a server: the project's first one that can be changed; the global list (which carries the button) when there is none.
  const host = current === undefined ? undefined : [...(projects.get(current)?.servers.values() ?? [])].find((s) => s.canDeploy);
  const addOn = (kind: "job" | "database") => {
    const list = `${kind}s`;
    const scope = current === undefined ? undefined : { project: current };
    if (current !== undefined && host !== undefined) {
      const back = enc(`/projects/${enc(current)}/${list}`);
      return { id: `action:add-${kind}`, group: "Actions" as const, label: `Add ${kind} to ${current}`, keywords: "create new", href: `/servers/${host.id}/config/${list}/new?from=${back}`, scope };
    }
    return { id: `action:add-${kind}`, group: "Actions" as const, label: `Add ${kind}`, keywords: "create new", href: current === undefined ? `/${list}` : `/${list}?project=${enc(current)}`, scope };
  };
  out.push(addOn("job"), addOn("database"));

  for (const [name, p] of projects) {
    out.push({ id: `project:${name}`, group: "Projects", label: name, hint: `${plural(p.apps, "app")} on ${plural(p.servers.size, "server")}`, href: `/projects/${enc(name)}`, scope: { project: name } });
    for (const t of PROJECT_TAB_ENTRIES) {
      out.push({ id: `${PROJECT_TAB_PREFIX}${name}:${t.id}`, group: "Projects", label: `${name} › ${t.label}`, keywords: t.keywords, href: hubTabHref(name, t.id), scope: { project: name } });
    }
  }
  for (const s of index.servers) out.push({ id: `server:${s.id}`, group: "Servers", label: s.name, hint: s.url, href: `/servers/${s.id}`, scope: { server: s.id } });

  for (const a of index.apps) {
    const scope = { server: a.server.id, app: a.name, project: a.project };
    const hint = [a.project, a.environment, a.server.name].filter(Boolean).join(" · ");
    out.push({ id: `app:${a.server.id}:${a.name}`, group: "Apps", label: a.name, hint, href: `/servers/${a.server.id}/apps/${enc(a.name)}`, scope });
    if (!a.server.canDeploy) continue;
    out.push({ id: `action:deploy:${a.server.id}:${a.name}`, group: "Actions", label: `Deploy ${a.name}…`, hint: a.server.name, keywords: "release ship version tag", href: ACTION_HREFS.deploy(a.server.id, a.name), scope });
    if (a.deployed && a.serving) {
      out.push({ id: `action:rollback:${a.server.id}:${a.name}`, group: "Actions", label: `Roll back ${a.name}…`, hint: a.server.name, keywords: "rollback previous undo revert", href: ACTION_HREFS.rollback(a.server.id, a.name), scope });
    }
  }
  for (const d of index.domains) {
    const owned = d.project !== undefined;
    out.push({
      id: `domain:${d.server.id}:${d.hostname}`,
      group: "Domains",
      label: d.hostname,
      hint: owned ? `${d.project} · ${d.server.name} · ${d.label}` : `${d.server.name} · ${d.label}`,
      keywords: "proxy route hostname dns",
      href: d.project === undefined ? `/servers/${d.server.id}/proxy` : hubTabHref(d.project, "domains"),
      scope: { server: d.server.id, ...(d.project === undefined ? {} : { project: d.project }) },
    });
  }
  for (const j of index.jobs) {
    const scope = { server: j.server.id, job: j.name, ...(j.project === undefined ? {} : { project: j.project }) };
    const hint = [j.project, j.server.name, j.schedule].filter(Boolean).join(" · ");
    out.push({ id: `job:${j.server.id}:${j.name}`, group: "Jobs", label: j.name, hint, href: `/servers/${j.server.id}/jobs/${enc(j.name)}`, scope });
    if (j.server.canDeploy && !j.running) {
      out.push({ id: `action:run:${j.server.id}:${j.name}`, group: "Actions", label: `Run job ${j.name}…`, hint: j.server.name, keywords: "execute trigger now", href: ACTION_HREFS.runJob(j.server.id, j.name), scope });
    }
  }
  for (const d of index.databases) {
    const hint = [d.project, d.server.name, d.target].filter(Boolean).join(" · ");
    out.push({ id: `database:${d.server.id}:${d.name}`, group: "Databases", label: d.name, hint, keywords: "backup restore", href: `/servers/${d.server.id}/databases/${enc(d.name)}`, scope: { server: d.server.id, ...(d.project === undefined ? {} : { project: d.project }) } });
  }
  for (const c of index.containers) {
    const scope = { server: c.server.id, container: c.name, ...(c.app === undefined ? {} : { app: c.app }) };
    out.push({ id: `container:${c.server.id}:${c.name}`, group: "Containers", label: c.name, hint: c.server.name, keywords: "logs", href: `/servers/${c.server.id}/containers/${enc(c.name)}`, scope });
    if (c.managed && c.server.canDeploy) {
      out.push(
        c.running
          ? { id: `action:restart:${c.server.id}:${c.name}`, group: "Actions", label: `Restart ${c.name}…`, hint: c.server.name, keywords: "reboot bounce", href: ACTION_HREFS.restart(c.server.id, c.name), scope }
          : { id: `action:start:${c.server.id}:${c.name}`, group: "Actions", label: `Start ${c.name}`, hint: c.server.name, keywords: "boot run up", href: ACTION_HREFS.start(c.server.id, c.name), scope },
      );
    }
  }
  for (const c of COMMANDS) out.push({ id: `pref:${c.id}`, group: "Preferences", label: c.label, keywords: c.keywords, command: c.command, shortcut: c.shortcut });
  return out;
}

// ---- The page you are on ---------------------------------------------------------------------------------------------------------

/** The page's subject, from its path: the actions about it come first. The global lists (/jobs, /databases) have no subject of their own. */
export function contextOf(pathname: string): PaletteScope {
  const part = (value: string | undefined) => (value === undefined ? undefined : decodeURIComponent(value));
  const project = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  if (project !== undefined) return { project: part(project) };
  const m = /^\/servers\/([^/]+)(?:\/(apps|jobs|containers|databases|deployments)\/([^/]+))?/.exec(pathname);
  if (!m || m[1] === "new") return {};
  const scope: PaletteScope = { server: m[1] };
  if (m[2] === "apps") scope.app = part(m[3]);
  if (m[2] === "jobs") scope.job = part(m[3]);
  if (m[2] === "containers") scope.container = part(m[3]);
  return scope;
}

/** Whether an entry is about what the page is about: every part of the page's subject that the entry has a say in agrees. */
function inContext(entry: PaletteEntry, context: PaletteScope): boolean {
  if (entry.scope === undefined) return false;
  const keys = (Object.keys(context) as (keyof PaletteScope)[]).filter((k) => context[k] !== undefined);
  if (keys.length === 0) return false;
  const specific = keys.filter((k) => k !== "server");
  // On an app, job or container page only that thing's own entries; on a server page, everything of that server.
  if (specific.length > 0) return specific.every((k) => entry.scope?.[k] === context[k]) && (context.server === undefined || entry.scope.server === context.server);
  return context.server !== undefined && entry.scope.server === context.server;
}

/** The actions that concern the page you are on: what the palette offers before you type anything. */
export function contextActions(entries: PaletteEntry[], context: PaletteScope, limit = 6): PaletteEntry[] {
  return entries.filter((e) => e.group === "Actions" && inContext(e, context)).slice(0, limit);
}

// ---- Ranking ---------------------------------------------------------------------------------------------------------------------

/**
 * How well a query token matches a text, 0 when it does not: exact, then a prefix, then the start of a word, then anywhere,
 * then the letters in order ("dpl" finds "deploy"), each worse than the one before.
 */
export function fuzzyScore(token: string, text: string): number {
  const t = text.toLowerCase();
  const q = token.toLowerCase();
  if (q === "" || t === "") return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 99);
  const word = t.search(new RegExp(`[\\s/._:-]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (word >= 0) return 800 - Math.min(word, 99);
  const at = t.indexOf(q);
  if (at >= 0) return 700 - Math.min(at, 99);
  if (q.length < 3) return 0;
  let from = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return 0;
    if (last >= 0 && i !== last + 1) gaps++;
    last = i;
    from = i + 1;
  }
  return Math.max(100, 400 - gaps * 40 - (t.length - q.length));
}

const WEIGHTS = { label: 1, keywords: 0.8, hint: 0.6, group: 0.4 } as const;

/** The score of an entry for a query: every word of it must match something; 0 when one does not. */
export function scoreEntry(entry: PaletteEntry, query: string): number {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    const best = Math.max(
      fuzzyScore(token, entry.label) * WEIGHTS.label,
      fuzzyScore(token, entry.keywords ?? "") * WEIGHTS.keywords,
      fuzzyScore(token, entry.hint ?? "") * WEIGHTS.hint,
      fuzzyScore(token, entry.group) * WEIGHTS.group,
    );
    if (best === 0) return 0;
    total += best;
  }
  return total / tokens.length;
}

const CONTEXT_BONUS = 120;
const RECENT_BONUS = 60;

export interface RankOptions {
  context?: PaletteScope;
  /** Ids of what was used last, newest first. */
  recent?: string[];
  limit?: number;
}

/** The entries that match the query, best first: the page you are on and what you used lately win ties. */
export function rank(entries: PaletteEntry[], query: string, { context = {}, recent = [], limit = 50 }: RankOptions = {}): PaletteEntry[] {
  const scored: { entry: PaletteEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const base = scoreEntry(entry, query);
    if (base === 0) return;
    const score = base + (inContext(entry, context) ? CONTEXT_BONUS : 0) + (recent.includes(entry.id) ? RECENT_BONUS - recent.indexOf(entry.id) : 0);
    scored.push({ entry, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => s.entry);
}

/** Splits a ranked list into groups in the order each group first appears: the group of the best match comes first. */
export function groupRanked(entries: PaletteEntry[]): { group: PaletteGroup; entries: PaletteEntry[] }[] {
  const groups = new Map<PaletteGroup, PaletteEntry[]>();
  for (const e of entries) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  return [...groups].map(([group, list]) => ({ group, entries: list }));
}

/** What the palette shows before anything is typed: recent uses, the page's own actions, the pages, the projects, the servers, the preferences. */
export function initialGroups(entries: PaletteEntry[], context: PaletteScope, recentIds: string[]): { group: PaletteGroup; entries: PaletteEntry[] }[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const recent = recentIds.flatMap((id) => byId.get(id) ?? []);
  const shown = new Set(recent.map((e) => e.id));
  const actions = contextActions(entries, context).filter((e) => !shown.has(e.id));
  const of = (group: PaletteGroup, limit = 50) => entries.filter((e) => e.group === group && !shown.has(e.id)).slice(0, limit);
  // A project's tabs are found by typing; the list before typing is the projects themselves.
  const projects = entries.filter((e) => e.group === "Projects" && !e.id.startsWith(PROJECT_TAB_PREFIX) && !shown.has(e.id)).slice(0, 8);
  return [
    { group: "Recent" as const, entries: recent.map((e) => ({ ...e, group: "Recent" as const, origin: e.group })) },
    { group: "Actions" as const, entries: actions },
    { group: "Go to" as const, entries: of("Go to") },
    { group: "Projects" as const, entries: projects },
    { group: "Servers" as const, entries: of("Servers", 8) },
    { group: "Preferences" as const, entries: of("Preferences") },
  ].filter((g) => g.entries.length > 0);
}

// ---- Recent ----------------------------------------------------------------------------------------------------------------------

export const RECENT_KEY = "keelson:palette:recent";
export const RECENT_MAX = 6;

/** The ids kept in the browser; anything else stored there (another version, a hand edit) is ignored. */
export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length <= 300).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** `id` moved to the front, once, at most RECENT_MAX kept. Preferences and the shortcuts sheet are not worth remembering. */
export function addRecent(ids: string[], entry: Pick<PaletteEntry, "id" | "group">): string[] {
  if (entry.group === "Preferences") return ids;
  return [entry.id, ...ids.filter((i) => i !== entry.id)].slice(0, RECENT_MAX);
}
