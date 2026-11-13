import type { Crumb } from "@/components/page-header";
import type { AttentionItem, ServerSnapshot } from "@/lib/attention-core";
import type { Tone } from "@/lib/status";

// Where things are: the sidebar's entries and which one is lit for a path, the breadcrumbs of the server pages, the tab
// bar of a server and the old `?tab=` links. Pure: components and pages only render what this decides.

export interface NavEntry {
  href: string;
  label: string;
  /** Other paths that belong to this entry. */
  also?: string[];
}

/**
 * The sidebar's main group, in order. Projects is where you operate (its list is live, like Servers'); the fleet-wide jobs and
 * databases lists are no entries of their own: they are sections of Home (and of the palette), so they light Home.
 */
export const NAV: NavEntry[] = [
  { href: "/", label: "Home", also: ["/jobs", "/databases"] },
  { href: "/projects", label: "Projects" },
  { href: "/servers", label: "Servers" },
  { href: "/delivery", label: "Delivery" },
  { href: "/activity", label: "Activity" },
];

/** The sidebar's footer group, above the account menu. */
export const FOOTER_NAV: NavEntry[] = [{ href: "/settings", label: "Settings" }];

/** The address of "New project", with the door (`image`), the repository and the server it was opened for (the only things the old "Add app from GitHub" addresses carried, and the door). */
export function newProjectHref(query: Record<string, string | string[] | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const key of ["server", "repo", "door"] as const) {
    const raw = query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  const text = params.toString();
  return text === "" ? "/projects/new" : `/projects/new?${text}`;
}

const within = (pathname: string, base: string): boolean => pathname === base || pathname.startsWith(`${base}/`);

/** The paths under /servers whose pages are about one entity (an app, a deployment, a container, a job, a database, or its configuration form): the ones an owning project can claim. */
const ENTITY_PATH = /^\/servers\/[^/]+\/(?:apps|deployments|containers|jobs|databases|config\/(?:apps|jobs|databases))\/[^/]+/;

/** Whether a path is a page about one entity of a server, which may belong to a project (see lib/owner-core). */
export const isEntityPath = (pathname: string): boolean => ENTITY_PATH.test(pathname);

/**
 * The entry that is lit for this path (one, never two): nested routes light their section, "/" only itself (and the
 * fleet-wide lists it holds). A page about an entity that belongs to a project (`owner`, the project the page itself
 * resolved: see projectOfCrumbs) lights Projects, as its breadcrumb says; without an owner it stays under Servers.
 */
export function activeNav(pathname: string, owner: string | null = null): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (owner !== null && isEntityPath(path)) return "/projects";
  for (const entry of [...NAV, ...FOOTER_NAV]) {
    if (entry.href === "/") {
      if (path === "/" || entry.also?.some((a) => within(path, a))) return entry.href;
      continue;
    }
    if (within(path, entry.href) || entry.also?.some((a) => within(path, a))) return entry.href;
  }
  return null;
}

/** The project a path of the hub is on (`/projects/shop/jobs` gives "shop"); null for the list and "new". */
export function activeProjectName(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match || match[1] === "new") return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** What the sidebar lights for a path: one section, and within Projects the project, within Servers the server (or the enrolment page) the path is on. */
export function sidebarActive(pathname: string, owner: string | null = null): { section: string | null; server: string | null; project: string | null; addServer: boolean; addProject: boolean } {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const section = activeNav(path, owner);
  return {
    section,
    server: section === "/servers" ? activeServerId(path) : null,
    project: section === "/projects" ? (owner !== null && isEntityPath(path) ? owner : activeProjectName(path)) : null,
    addServer: path === "/servers/new",
    addProject: path === "/projects/new",
  };
}

/**
 * Whether the Servers entry itself is lit. On the list page, yes; on a server's page the server under it is lit instead, so
 * the entry is not, unless that list is not showing (folded away, or an icon-only sidebar): then the entry stands for the
 * place, so the current page is never left unmarked.
 */
export function serversEntryLit(pathname: string, listShown: boolean, owner: string | null = null): boolean {
  const a = sidebarActive(pathname, owner);
  if (a.section !== "/servers") return false;
  return !listShown || (a.server === null && !a.addServer);
}

/** Same for the Projects entry: lit on the list page, while the list under it marks New project or the project the path is on, unless that list is not showing. */
export function projectsEntryLit(pathname: string, listShown: boolean, owner: string | null = null): boolean {
  const a = sidebarActive(pathname, owner);
  if (a.section !== "/projects") return false;
  return !listShown || (a.project === null && !a.addProject);
}

/** The server whose pages this path belongs to, for the sidebar's list; "new" is the enrolment page, not a server. */
export function activeServerId(pathname: string): string | null {
  const match = /^\/servers\/([^/]+)(?:\/|$)/.exec(pathname);
  return match && match[1] !== "new" ? decodeURIComponent(match[1]) : null;
}

/** The breadcrumb of a page of one server: Servers, the server, then where on it. */
export function serverCrumbs(server: { id: string; name: string }, ...rest: Crumb[]): Crumb[] {
  return [{ label: "Servers", href: "/servers" }, rest.length > 0 ? { label: server.name, href: `/servers/${server.id}` } : { label: server.name }, ...rest];
}

/**
 * The project a validated `?from=` return path (see safeReturnPath) points into: `/projects/<p>/apps` gives `p`, and a
 * global list narrowed to a project (`/jobs?project=<p>`) too. Null for anything else.
 */
export function projectOfReturnPath(from: string | string[] | undefined): string | null {
  const path = safeReturnPath(from);
  if (path === null) return null;
  if (LIST_PATH.test(path)) return new URL(path, "http://keelson.invalid").searchParams.get("project") || null;
  const segment = path.slice("/projects/".length).split(/[/?#]/)[0];
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Breadcrumbs of a page reached from a hub tab: Projects > <project> > <tab> > ...rest. */
export function hubCrumbs(project: string, tab: Crumb, ...rest: Crumb[]): Crumb[] {
  return [{ label: "Projects", href: "/projects" }, { label: project, href: projectHref(project) }, tab, ...rest];
}

/**
 * Breadcrumbs for a page opened from a hub tab (`?from=/projects/<p>/<tab>`) or from a global list (`?from=/jobs?project=<p>`):
 * Projects > <p> > <Tab> > ...rest; null when `from` is not a valid path or names no project.
 */
export function returnCrumbs(from: string | string[] | undefined, ...rest: Crumb[]): Crumb[] | null {
  const project = projectOfReturnPath(from);
  const path = safeReturnPath(from);
  if (project === null || path === null) return null;
  const list = LIST_PATH.exec(path);
  if (list) return hubCrumbs(project, { label: list[1] === "jobs" ? "Jobs" : "Databases", href: path }, ...rest);
  const tabId = path.slice("/projects/".length).split(/[?#]/)[0].split("/")[1];
  const tab = PROJECT_TABS.find((t) => t.id !== "overview" && t.id === tabId);
  return hubCrumbs(project, tab ? { label: tab.label, href: `${projectHref(project)}/${tab.id}` } : { label: "Overview", href: projectHref(project) }, ...rest);
}

/** A project's page. */
export const projectHref = (name: string): string => `/projects/${encodeURIComponent(name)}`;

/** The project a breadcrumb trail belongs to (`Projects > shop > ...`), read from its links; null for any other trail. The shell lights Projects from it. */
export function projectOfCrumbs(crumbs: Crumb[] | undefined): string | null {
  if (!crumbs || crumbs.length < 2 || crumbs[0].href !== "/projects") return null;
  const href = crumbs[1].href;
  if (href === undefined) return null;
  const match = /^\/projects\/([^/?#]+)$/.exec(href);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The address of a tab of a project's hub. */
export const hubTabHref = (project: string, tab: ProjectTabId): string => (tab === "overview" ? projectHref(project) : `${projectHref(project)}/${tab}`);

/**
 * Where a config form returns to and which project it belongs to: the validated `?from=` of the link that opened it, else the
 * tab of the entity's owning project (derived, so a link needs no `from`), else nothing (the form stays under its server).
 */
export function returnTo(from: string | string[] | undefined, owner: string | null, tab: ProjectTabId): { from: string | undefined; project: string | undefined } {
  const given = safeReturnPath(from);
  if (given !== null) return { from: given, project: projectOfReturnPath(from) ?? undefined };
  return owner === null ? { from: undefined, project: undefined } : { from: hubTabHref(owner, tab), project: owner };
}

/** A tab of a project as a crumb. */
export function hubTabCrumb(project: string, tab: ProjectTabId): Crumb {
  const label = PROJECT_TABS.find((t) => t.id === tab)?.label ?? "Overview";
  return { label, href: hubTabHref(project, tab) };
}

/**
 * The breadcrumb of a page about an entity of a server (an app, a job, a database, a deployment, a container, a form):
 * under its project's tab when it belongs to one (`Projects > shop > Jobs > nightly`), under the server otherwise (unassigned
 * entities, server-level pages: `Servers > vps-1 > ...`).
 */
export function entityCrumbs(owner: string | null, tab: ProjectTabId, server: { id: string; name: string }, ...rest: Crumb[]): Crumb[] {
  return owner === null ? serverCrumbs(server, ...rest) : hubCrumbs(owner, hubTabCrumb(owner, tab), ...rest);
}

export type TabId = "overview" | "containers" | "proxy";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "containers", label: "Containers" },
  { id: "proxy", label: "Proxy" },
];

/** A server's jobs or databases: the global list, filtered to it (they used to be tabs of the server). */
export const serverListHref = (kind: "jobs" | "databases", serverId: string): string => `/${kind}?server=${encodeURIComponent(serverId)}`;

const MACHINE_TABS: readonly TabId[] = ["overview", "containers"];

export const tabHref = (serverId: string, tab: TabId): string => (tab === "overview" ? `/servers/${serverId}` : `/servers/${serverId}/${tab}`);

/** The tab a path of this server is on, or null for the server's other pages (an app, its configuration, a job...), which have no tab bar. */
export function activeTab(pathname: string, serverId: string): TabId | null {
  const base = `/servers/${serverId}`;
  const path = pathname.replace(/\/+$/, "");
  if (path === base) return "overview";
  return TABS.find((t) => t.id !== "overview" && path === `${base}/${t.id}`)?.id ?? null;
}

/**
 * What `?tab=` used to select, as the route that replaced it (the jobs and databases tabs are the global lists, filtered
 * to the server); null when the URL has no `tab` and nothing is to be redirected.
 */
export function legacyTabHref(serverId: string, tab: string | string[] | undefined): string | null {
  if (tab === undefined) return null;
  const wanted = Array.isArray(tab) ? tab[0] : tab;
  if (wanted === "jobs" || wanted === "databases") return serverListHref(wanted, serverId);
  const known = TABS.find((t) => t.id === wanted);
  return tabHref(serverId, known?.id ?? "overview");
}

export interface TabAttention {
  tone: Tone;
  /** How many things need a look on this tab. */
  count: number;
  /** For screen readers and the tooltip: the colour is never the only carrier. */
  label: string;
}

export interface TabView {
  id: TabId;
  label: string;
  href: string;
  /** How many containers or routes; absent when the agent did not say. */
  count?: number;
  attention?: TabAttention;
}

/** Which attention items belong to which tab; the rest (host, deployments, unreachable) are the overview's own. */
function onTab(tab: TabId, item: AttentionItem): boolean {
  switch (tab) {
    case "containers":
      return item.kind === "container" || (item.kind === "app-down" && item.severity !== "info");
    case "proxy":
      return item.kind === "proxy";
    case "overview":
      return false;
  }
}

const RANK: Record<AttentionItem["severity"], number> = { critical: 2, warning: 1, info: 0 };
const TONE: Record<AttentionItem["severity"], Tone> = { critical: "danger", warning: "warning", info: "info" };

function attentionOf(tab: TabId, items: AttentionItem[]): TabAttention | undefined {
  const mine = items.filter((i) => onTab(tab, i));
  if (mine.length === 0) return undefined;
  const worst = mine.reduce((w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w), mine[0].severity);
  return { tone: TONE[worst], count: mine.length, label: mine.length === 1 ? "1 thing needs attention" : `${mine.length} things need attention` };
}

/** The tabs before the agent has answered: every one, as links, with no counts. */
export function baseTabs(serverId: string, machine = false): TabView[] {
  // A machine that connects out serves nothing: only its state and its containers.
  return TABS.filter((t) => !machine || MACHINE_TABS.includes(t.id)).map((t) => ({ ...t, href: tabHref(serverId, t.id) }));
}

/**
 * The tab bar of a server from what it answered: the tabs of what the agent offers (an agent without an apps file has no
 * proxy to show), each with its count and a dot where the attention model has items for it. A part that failed or an
 * agent that did not answer keeps its tab, without a count: unknown is not zero.
 */
export function serverTabs(serverId: string, snapshot: ServerSnapshot, items: AttentionItem[], machine = false): TabView[] {
  const mine = items.filter((i) => i.server.id === serverId);
  const counts: Record<TabId, number | undefined> = {
    overview: undefined,
    containers: snapshot.containers?.length,
    proxy: snapshot.proxy?.routes.length,
  };
  const absent = (tab: TabId): boolean => snapshot.reachable && tab === "proxy" && snapshot.apps === null;
  return baseTabs(serverId, machine)
    .filter((t) => !absent(t.id))
    .map((t) => {
      const attention = attentionOf(t.id, mine);
      return { ...t, ...(counts[t.id] !== undefined ? { count: counts[t.id] } : {}), ...(attention ? { attention } : {}) };
    });
}

export type ProjectTabId = "overview" | "apps" | "jobs" | "databases" | "domains" | "variables" | "source" | "readiness" | "config";

export interface ProjectTabView {
  id: ProjectTabId;
  label: string;
  href: string;
  count?: number;
  attention?: boolean;
}

const PROJECT_TABS: { id: ProjectTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "apps", label: "Apps" },
  { id: "jobs", label: "Jobs" },
  { id: "databases", label: "Databases" },
  { id: "domains", label: "Domains" },
  { id: "variables", label: "Variables" },
  { id: "source", label: "Source" },
  { id: "readiness", label: "Readiness" },
  { id: "config", label: "Configuration" },
];

/** The tab bar of a project: the overview is the project's own address, every other tab is a page under it. */
export function projectTabs(project: string, counts: Partial<Record<ProjectTabId, number>> = {}, attention: ProjectTabId[] = []): ProjectTabView[] {
  const base = projectHref(project);
  return PROJECT_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    href: t.id === "overview" ? base : `${base}/${t.id}`,
    ...(counts[t.id] !== undefined ? { count: counts[t.id] } : {}),
    ...(attention.includes(t.id) ? { attention: true } : {}),
  }));
}

/** The tab a path of this project is on; any other path under the project (or none) is the overview. */
export function activeProjectTab(pathname: string, project: string): ProjectTabId {
  const base = projectHref(project);
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : pathname.startsWith(`/projects/${project}/`) ? pathname.slice(`/projects/${project}/`.length) : "";
  const first = rest.split("/")[0];
  return PROJECT_TABS.find((t) => t.id !== "overview" && t.id === first)?.id ?? "overview";
}

/** The global lists a form can return to: `/jobs` and `/databases`, with their `?server=` / `?project=` filter. */
const LIST_PATH = /^\/(jobs|databases)(\?|$)/;

/**
 * Where a form returns to after it saved or was cancelled, from the `?from=` of the link that opened it: only a path of
 * this site under /projects/ (or the global jobs and databases lists) is accepted, anything else (another site, a
 * scheme-relative address, a backslash, a control character, a dot segment) is refused so the link can never be an open redirect.
 */
export function safeReturnPath(from: string | string[] | undefined): string | null {
  if (typeof from !== "string") return null;
  if (!(from.startsWith("/projects/") || LIST_PATH.test(from)) || from.length > 512) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(from)) return null;
  if (from.includes("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(from);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("//") || decoded.split(/[/?#]/).some((s) => s === "." || s === "..")) return null;
  return from;
}
