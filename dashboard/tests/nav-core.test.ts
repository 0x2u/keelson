import { describe, expect, it } from "vitest";
import type { AppStatus, Container, DatabaseStatus, JobStatus } from "@/lib/agent-types";
import { attentionItems, type ServerSnapshot } from "@/lib/attention-core";
import { FOOTER_NAV, NAV, activeNav, activeProjectName, entityCrumbs, hubTabCrumb, hubTabHref, isEntityPath, projectOfCrumbs, projectsEntryLit, returnTo, projectHref, newProjectHref, activeServerId, activeTab, baseTabs, legacyTabHref, serverCrumbs, serverListHref, serversEntryLit, serverTabs, sidebarActive, tabHref } from "@/lib/nav-core";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SERVER = { id: "s1", name: "vps-1" };

describe("the sidebar", () => {
  it("lists Home, Projects, Servers, Delivery and Activity, with Settings in the footer: no Databases and no Jobs entry", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Home", "Projects", "Servers", "Delivery", "Activity"]);
    expect(FOOTER_NAV.map((n) => n.label)).toEqual(["Settings"]);
  });

  it("lights Home only on the home page, not on everything below /", () => {
    expect(activeNav("/")).toBe("/");
    expect(activeNav("/projects")).toBe("/projects");
    expect(activeNav("/nope")).toBeNull();
  });

  it("lights an entry for every route nested under it", () => {
    expect(activeNav("/projects/shop")).toBe("/projects");
    expect(activeNav("/settings")).toBe("/settings");
    expect(activeNav("/settings/security")).toBe("/settings");
    expect(activeNav("/settings/api-tokens")).toBe("/settings");
    expect(activeNav("/settings/integrations")).toBe("/settings");
    expect(activeNav("/activity")).toBe("/activity");
  });

  it("puts everything under /servers, tabs and sub-pages alike, in Servers, and the server-wide pages in their own entry only when they are", () => {
    for (const path of ["/servers", "/servers/new", "/servers/s1", "/servers/s1/containers", "/servers/s1/databases", "/servers/s1/databases/main", "/servers/s1/jobs/nightly", "/servers/s1/config/jobs/new", "/servers/s1/apps/shop"]) {
      expect(activeNav(path), path).toBe("/servers");
    }
  });

  it("lights Home for the fleet-wide jobs and databases lists: they are sections of Home, not entries of their own", () => {
    expect(activeNav("/jobs")).toBe("/");
    expect(activeNav("/databases")).toBe("/");
    expect(activeNav("/jobs/")).toBe("/");
  });

  it("lights Projects, not Servers, for a page of an entity that a project owns, and only then", () => {
    for (const path of ["/servers/s1/apps/shop", "/servers/s1/deployments/d1", "/servers/s1/containers/shop-1", "/servers/s1/jobs/nightly", "/servers/s1/databases/main", "/servers/s1/config/apps/shop", "/servers/s1/config/jobs/nightly"]) {
      expect(isEntityPath(path), path).toBe(true);
      expect(activeNav(path, "shop"), path).toBe("/projects");
      expect(activeNav(path, null), path).toBe("/servers");
    }
    // A server's own pages (its tabs, settings, the lists) stay under Servers whatever an owner says.
    for (const path of ["/servers/s1", "/servers/s1/containers", "/servers/s1/settings", "/servers/s1/config", "/servers/s1/config/versions", "/servers/s1/apps"]) {
      expect(isEntityPath(path), path).toBe(false);
      expect(activeNav(path, "shop"), path).toBe("/servers");
    }
  });

  it("belongs the new-project page to Projects, and does not confuse a prefix with a section", () => {
    expect(activeNav("/projects/new")).toBe("/projects");
    expect(activeNav("/projects-old")).toBeNull();
    expect(activeNav("/serversx")).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(activeNav("/servers/")).toBe("/servers");
    expect(activeNav("/settings/security/")).toBe("/settings");
  });

  it("tells which server the path is on, and that /servers/new is no server", () => {
    expect(activeServerId("/servers/abc")).toBe("abc");
    expect(activeServerId("/servers/abc/config/apps/web")).toBe("abc");
    expect(activeServerId("/servers/new")).toBeNull();
    expect(activeServerId("/servers")).toBeNull();
    expect(activeServerId("/jobs")).toBeNull();
    expect(activeServerId("/servers/a%20b/jobs")).toBe("a b");
  });

  it("lights the list only where no server or enrolment is lit", () => {
    expect(sidebarActive("/servers")).toEqual({ section: "/servers", server: null, project: null, addServer: false, addProject: false });
    expect(sidebarActive("/servers/s1/containers")).toEqual({ section: "/servers", server: "s1", project: null, addServer: false, addProject: false });
    expect(sidebarActive("/servers/new")).toEqual({ section: "/servers", server: null, project: null, addServer: true, addProject: false });
    expect(sidebarActive("/databases")).toEqual({ section: "/", server: null, project: null, addServer: false, addProject: false });
  });

  it("lights the project of the hub's pages, and of an owned entity's pages instead of its server", () => {
    expect(sidebarActive("/projects")).toMatchObject({ section: "/projects", project: null });
    expect(sidebarActive("/projects/new")).toMatchObject({ section: "/projects", project: null });
    expect(sidebarActive("/projects/shop/jobs")).toMatchObject({ section: "/projects", project: "shop" });
    expect(sidebarActive("/projects/a%20b")).toMatchObject({ project: "a b" });
    expect(sidebarActive("/servers/s1/apps/shop", "shop")).toEqual({ section: "/projects", server: null, project: "shop", addServer: false, addProject: false });
    expect(activeProjectName("/servers/s1")).toBeNull();
  });
});

describe("the Projects entry", () => {
  it("is lit on the list page, and on New project or a project's pages only while its list is not showing", () => {
    expect(projectsEntryLit("/projects", true)).toBe(true);
    expect(projectsEntryLit("/projects/new", true)).toBe(false);
    expect(projectsEntryLit("/projects/new", false)).toBe(true);
    expect(projectsEntryLit("/projects/shop", true)).toBe(false);
    expect(projectsEntryLit("/projects/shop", false)).toBe(true);
    expect(projectsEntryLit("/servers/s1/apps/shop", true, "shop")).toBe(false);
    expect(projectsEntryLit("/servers/s1/apps/shop", false, "shop")).toBe(true);
    expect(projectsEntryLit("/servers/s1", false)).toBe(false);
  });
});

describe("the Servers entry", () => {
  it("is lit on the list page only, while the list below it marks the server or the enrolment page", () => {
    expect(serversEntryLit("/servers", true)).toBe(true);
    expect(serversEntryLit("/servers/s1/containers", true)).toBe(false);
    expect(serversEntryLit("/servers/new", true)).toBe(false);
    expect(serversEntryLit("/databases", true)).toBe(false);
    expect(serversEntryLit("/servers/s1/apps/shop", false, "shop")).toBe(false);
  });

  it("is lit on every page under /servers when its list is folded away or hidden, so the place is never unmarked", () => {
    for (const path of ["/servers", "/servers/s1", "/servers/s1/jobs", "/servers/s1/config/apps/web", "/servers/new"]) expect(serversEntryLit(path, false), path).toBe(true);
    expect(serversEntryLit("/jobs", false)).toBe(false);
  });
});

describe("breadcrumbs", () => {
  it("start a server's pages at Servers, never at Home, and link the server unless it is the page", () => {
    expect(serverCrumbs(SERVER)).toEqual([{ label: "Servers", href: "/servers" }, { label: "vps-1" }]);
    expect(serverCrumbs(SERVER, { label: "Audit log" })).toEqual([{ label: "Servers", href: "/servers" }, { label: "vps-1", href: "/servers/s1" }, { label: "Audit log" }]);
  });

  it("start the page of an entity a project owns at Projects, under the tab it lives in", () => {
    expect(entityCrumbs("shop", "apps", SERVER, { label: "web" })).toEqual([{ label: "Projects", href: "/projects" }, { label: "shop", href: "/projects/shop" }, { label: "Apps", href: "/projects/shop/apps" }, { label: "web" }]);
    expect(entityCrumbs("shop", "jobs", SERVER, { label: "nightly" }).map((c) => c.label)).toEqual(["Projects", "shop", "Jobs", "nightly"]);
    expect(entityCrumbs("a b", "databases", SERVER, { label: "main" })[1]).toEqual({ label: "a b", href: "/projects/a%20b" });
  });

  it("keep what no project owns (an unassigned job, a server page) under its server", () => {
    expect(entityCrumbs(null, "apps", SERVER, { label: "web" })).toEqual([{ label: "Servers", href: "/servers" }, { label: "vps-1", href: "/servers/s1" }, { label: "web" }]);
  });

  it("read the project of a trail back from its links, for the sidebar", () => {
    expect(projectOfCrumbs(entityCrumbs("shop", "apps", SERVER, { label: "web" }))).toBe("shop");
    expect(projectOfCrumbs(entityCrumbs("a b", "jobs", SERVER, { label: "x" }))).toBe("a b");
    expect(projectOfCrumbs(entityCrumbs(null, "apps", SERVER, { label: "x" }))).toBeNull();
    expect(projectOfCrumbs([{ label: "Projects", href: "/projects" }, { label: "New project" }])).toBeNull();
    expect(projectOfCrumbs([{ label: "Projects", href: "/projects" }, { label: "shop" }])).toBeNull();
    expect(projectOfCrumbs(undefined)).toBeNull();
  });

  it("address the tabs of a hub", () => {
    expect(hubTabHref("shop", "overview")).toBe("/projects/shop");
    expect(hubTabHref("shop", "apps")).toBe("/projects/shop/apps");
    expect(hubTabCrumb("shop", "config")).toEqual({ label: "Configuration", href: "/projects/shop/config" });
  });

  it("derive where a form returns to: the link's own `from`, else the owner's tab, else nowhere", () => {
    expect(returnTo("/projects/shop/jobs", "other", "apps")).toEqual({ from: "/projects/shop/jobs", project: "shop" });
    expect(returnTo(undefined, "shop", "jobs")).toEqual({ from: "/projects/shop/jobs", project: "shop" });
    expect(returnTo("https://evil.example", "shop", "apps")).toEqual({ from: "/projects/shop/apps", project: "shop" });
    expect(returnTo(undefined, null, "apps")).toEqual({ from: undefined, project: undefined });
  });

  it("encode a project name in its address", () => {
    expect(projectHref("a b/c")).toBe("/projects/a%20b%2Fc");
  });
});

describe("the server's tabs as routes", () => {
  it("gives each tab its own path", () => {
    expect(["overview", "containers", "proxy"].map((t) => tabHref("s1", t as never))).toEqual(["/servers/s1", "/servers/s1/containers", "/servers/s1/proxy"]);
  });

  it("marks the tab of the current path and none on the server's other pages", () => {
    expect(activeTab("/servers/s1", "s1")).toBe("overview");
    expect(activeTab("/servers/s1/", "s1")).toBe("overview");
    expect(activeTab("/servers/s1/containers", "s1")).toBe("containers");
    expect(activeTab("/servers/s1/proxy", "s1")).toBe("proxy");
    expect(activeTab("/servers/s1/jobs", "s1")).toBeNull();
    expect(activeTab("/servers/s1/databases", "s1")).toBeNull();
    expect(activeTab("/servers/s1/jobs/nightly", "s1")).toBeNull();
    expect(activeTab("/servers/s1/databases/main", "s1")).toBeNull();
    expect(activeTab("/servers/s1/config", "s1")).toBeNull();
    expect(activeTab("/servers/s2/containers", "s1")).toBeNull();
  });
});

describe("old ?tab= links", () => {
  it("redirect to the route that replaced each tab: the jobs and databases tabs became the global lists", () => {
    expect(legacyTabHref("s1", "containers")).toBe("/servers/s1/containers");
    expect(legacyTabHref("s1", "proxy")).toBe("/servers/s1/proxy");
    expect(legacyTabHref("s1", "jobs")).toBe("/jobs?server=s1");
    expect(legacyTabHref("s1", "databases")).toBe("/databases?server=s1");
    expect(legacyTabHref("s1", "overview")).toBe("/servers/s1");
  });

  it("drop an unknown tab, take the first of a repeated one, and leave a URL without tab alone", () => {
    expect(legacyTabHref("s1", "nonsense")).toBe("/servers/s1");
    expect(legacyTabHref("s1", ["jobs", "proxy"])).toBe("/jobs?server=s1");
    expect(legacyTabHref("s1", undefined)).toBeNull();
  });

  it("address a server's jobs and databases as the global list narrowed to it, encoding the id", () => {
    expect(serverListHref("jobs", "s1")).toBe("/jobs?server=s1");
    expect(serverListHref("databases", "a b")).toBe("/databases?server=a%20b");
  });
});

const container = (over: Partial<Container> = {}): Container =>
  ({ id: "c1", name: "web-1", image: "nginx", state: "running", status: "Up 2 hours", ports: [], labels: {}, created: 0, ...over }) as Container;

const job = (over: Partial<JobStatus> = {}): JobStatus => ({ name: "nightly", schedule: "0 3 * * *", timezone: "UTC", kind: "http", target: "GET http://x", paused: false, running: false, ...over });

const database = (backup: Partial<NonNullable<DatabaseStatus["backup"]>> | null): DatabaseStatus => ({
  name: "main",
  engine: "postgres",
  host: "db",
  port: 5432,
  database: "main",
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: backup === null ? null : { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: "backup-main", next_run: ago(-HOUR), last_run: null, ...backup },
});

const snap = (over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({ server: SERVER, reachable: true, lastSeen: NOW, apps: [], jobs: [], databases: [], containers: [], proxy: null, ...over });
const tabsOf = (over: Partial<ServerSnapshot> = {}) => {
  const s = snap(over);
  return serverTabs("s1", s, attentionItems([s], NOW));
};
const by = (tabs: ReturnType<typeof tabsOf>, id: string) => tabs.find((t) => t.id === id);

describe("the tab bar from what the agent said", () => {
  it("shows the three tabs of a healthy server with their counts and no dot", () => {
    const tabs = tabsOf({
      containers: [container()],
      jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "succeeded", started_at: ago(HOUR) } })],
      databases: [database({ last_run: { id: "b", status: "succeeded", started_at: ago(HOUR), finished_at: ago(HOUR) } })],
      proxy: { type: "caddy", where: "", generated: "", routes: [], unrouted: [], in_sync: true },
    });
    expect(tabs.map((t) => [t.id, t.count])).toEqual([["overview", undefined], ["containers", 1], ["proxy", 0]]);
    expect(tabs.every((t) => t.attention === undefined)).toBe(true);
  });

  it("puts a dot on Containers for a stopped or unhealthy container, with the worst tone and a readable label", () => {
    const stopped = tabsOf({ containers: [container({ name: "shop-1", state: "exited", status: "Exited (1)", labels: { "keelson.app": "shop" } })] });
    expect(by(stopped, "containers")?.attention).toEqual({ tone: "danger", count: 1, label: "1 thing needs attention" });
    const sick = tabsOf({ containers: [container({ status: "Up 1 hour (unhealthy)" }), container({ id: "c2", name: "db", status: "Up (unhealthy)" })] });
    expect(by(sick, "containers")?.attention).toMatchObject({ tone: "danger", count: 2, label: "2 things need attention" });
    expect(by(sick, "proxy")?.attention).toBeUndefined();
  });

  it("puts a dot on Containers for an app whose container stopped, even when no container is listed", () => {
    const app = {
      name: "shop",
      container: { id: "c", name: "shop-1", image: "x:1", state: { status: "exited", running: false, restarting: false, exit_code: 2, started_at: ago(HOUR), finished_at: ago(60_000) } },
      last_deployment: null,
    } as unknown as AppStatus;
    expect(by(tabsOf({ apps: [app] }), "containers")?.attention?.tone).toBe("danger");
  });

  it("puts a dot on Proxy when its configuration is not in sync, and on nothing else", () => {
    const tabs = tabsOf({ proxy: { type: "nginx", where: "", generated: "", routes: [], unrouted: [], in_sync: false } });
    expect(by(tabs, "proxy")?.attention).toMatchObject({ tone: "warning", count: 1 });
    expect(tabs.filter((t) => t.attention).map((t) => t.id)).toEqual(["proxy"]);
  });

  it("has no Jobs or Databases tab, and so no dot for a failing job or backup: they are lists of their own, linked from the overview", () => {
    const failed = { id: "r", job: "nightly", trigger: "schedule" as const, status: "failed" as const, detail: "HTTP 500", started_at: ago(HOUR), finished_at: ago(HOUR) };
    const tabs = tabsOf({ jobs: [job({ last_run: failed })], databases: [database({ last_run: { ...failed, id: "b" } })] });
    expect(tabs.map((t) => t.id)).toEqual(["overview", "containers", "proxy"]);
    expect(tabs.filter((t) => t.attention)).toEqual([]);
  });

  it("leaves host problems (disk, memory) and deployments to the overview, which has no dot of its own", () => {
    const tabs = tabsOf({ system: { time: ago(0), host: { cpus: 2, disk: { path: "/", total: 100, free: 2 } } } });
    expect(tabs.filter((t) => t.attention)).toEqual([]);
  });

  it("drops the tabs of what an agent without an apps file does not offer", () => {
    const tabs = tabsOf({ apps: null, jobs: null, databases: null });
    expect(tabs.map((t) => t.id)).toEqual(["overview", "containers"]);
  });

  it("keeps every tab, without counts, when the agent did not answer: unknown is not zero", () => {
    const s: ServerSnapshot = { server: SERVER, reachable: false, reason: "connect ECONNREFUSED", lastSeen: null };
    const tabs = serverTabs("s1", s, attentionItems([s], NOW));
    expect(tabs.map((t) => t.id)).toEqual(baseTabs("s1").map((t) => t.id));
    expect(tabs.every((t) => t.count === undefined && t.attention === undefined)).toBe(true);
  });

  it("keeps the tab of a part that failed while the agent answers, without a count", () => {
    const tabs = tabsOf({ proxy: undefined, errors: { proxy: "boom" } });
    expect(by(tabs, "proxy")).toMatchObject({ id: "proxy", href: "/servers/s1/proxy" });
    expect(by(tabs, "proxy")?.count).toBeUndefined();
  });
});

describe("newProjectHref", () => {
  it("keeps the repository and the server of an old add-app address, and nothing else", () => {
    expect(newProjectHref({ repo: "acme/shop", server: "s1", utm: "x", token: "t" })).toBe("/projects/new?server=s1&repo=acme%2Fshop");
    expect(newProjectHref({ repo: ["a/b", "c/d"] })).toBe("/projects/new?repo=a%2Fb");
    expect(newProjectHref({ repo: "" })).toBe("/projects/new");
    expect(newProjectHref()).toBe("/projects/new");
  });
});

describe("the tab bar of a machine that connects out", () => {
  it("has only its overview and its containers: it serves nothing", () => {
    const s = snap({ containers: [container()] });
    expect(serverTabs("s1", s, attentionItems([s], NOW), true).map((t) => t.id)).toEqual(["overview", "containers"]);
    expect(baseTabs("s1", true).map((t) => t.id)).toEqual(["overview", "containers"]);
    expect(baseTabs("s1").map((t) => t.id)).toEqual(["overview", "containers", "proxy"]);
  });
});
