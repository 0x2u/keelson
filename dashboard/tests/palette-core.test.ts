import { describe, expect, it } from "vitest";
import {
  ACTION_HREFS,
  GO_TO,
  RECENT_MAX,
  addRecent,
  buildRegistry,
  contextActions,
  contextOf,
  emptyIndex,
  fuzzyScore,
  groupRanked,
  initialGroups,
  parseRecent,
  rank,
  scoreEntry,
  type PaletteEntry,
  type PaletteIndex,
} from "@/lib/palette-core";

const prod = { id: "s1", name: "prod", canDeploy: true };
const readonly = { id: "s2", name: "edge", canDeploy: false };

const index = (): PaletteIndex => ({
  servers: [
    { ...prod, url: "https://prod.example.com:8443" },
    { ...readonly, url: "http://10.0.0.2:8443" },
  ],
  apps: [
    { server: prod, name: "web", project: "shop", environment: "production", image: "ghcr.io/me/web", serving: true, deployed: true },
    { server: prod, name: "api", project: "shop", environment: "production", image: "ghcr.io/me/api", serving: false, deployed: false },
    { server: readonly, name: "blog", project: "blog", environment: "production", image: "ghost", serving: true, deployed: true },
  ],
  jobs: [
    { server: prod, name: "nightly", project: "shop", schedule: "0 3 * * *", running: false, paused: false },
    { server: prod, name: "busy", schedule: "* * * * *", running: true, paused: false },
    { server: readonly, name: "ping", schedule: "*/5 * * * *", running: false, paused: false },
  ],
  databases: [
    { server: prod, name: "kv-pg", project: "shop", target: "postgres@db:5432/shop" },
    { server: readonly, name: "scratch", target: "postgres@db:5432/x" },
  ],
  containers: [
    { server: prod, name: "web-blue", running: true, managed: true, app: "web" },
    { server: prod, name: "old", running: false, managed: true },
    { server: prod, name: "pg", running: true, managed: false },
    { server: readonly, name: "ghost", running: true, managed: true },
  ],
  domains: [
    { server: prod, hostname: "shop.example.com", project: "shop", label: "web" },
    { server: readonly, hostname: "orphan.example.com", label: "site" },
  ],
  truncated: false,
});

const registry = () => buildRegistry(index());
const find = (id: string) => registry().find((e) => e.id === id);
const labels = (entries: PaletteEntry[]) => entries.map((e) => e.label);

describe("buildRegistry", () => {
  it("lists every page to go to, with the shortcuts that go there", () => {
    const go = registry().filter((e) => e.group === "Go to");
    expect(labels(go)).toEqual(["Home", "Projects", "Servers", "Databases", "Jobs", "Activity", "Settings", "Security", "API tokens", "Integrations", "Notifications", "Add server", "New project"]);
    expect(Object.fromEntries(go.filter((e) => e.shortcut).map((e) => [e.label, e.shortcut?.join(" ")]))).toEqual({ Home: "g h", Projects: "g p", Servers: "g s", Databases: "g d", Jobs: "g j", Activity: "g a" });
    expect(GO_TO.map((g) => g.href)).toEqual(expect.arrayContaining(["/settings", "/settings/security", "/settings/api-tokens", "/settings/integrations", "/settings/notifications", "/servers/new", "/projects/new"]));
    expect(GO_TO.find((g) => g.id === "notifications")?.href).toBe("/settings/notifications");
  });

  it("lists a project's tabs, each linking to its hub tab", () => {
    const tabs = registry().filter((e) => e.group === "Projects" && e.id.startsWith("project-tab:shop:"));
    expect(tabs.map((e) => [e.id, e.label, e.href])).toEqual([
      ["project-tab:shop:apps", "shop › Apps", "/projects/shop/apps"],
      ["project-tab:shop:jobs", "shop › Jobs", "/projects/shop/jobs"],
      ["project-tab:shop:databases", "shop › Databases", "/projects/shop/databases"],
      ["project-tab:shop:domains", "shop › Domains", "/projects/shop/domains"],
      ["project-tab:shop:variables", "shop › Variables", "/projects/shop/variables"],
      ["project-tab:shop:source", "shop › Source", "/projects/shop/source"],
      ["project-tab:shop:readiness", "shop › Readiness", "/projects/shop/readiness"],
      ["project-tab:shop:config", "shop › Configuration", "/projects/shop/config"],
    ]);
    expect(tabs.every((e) => e.scope?.project === "shop")).toBe(true);
    expect(registry().some((e) => e.id === "project-tab:shop:overview")).toBe(false);
  });

  it("lists projects, servers, apps, domains, jobs, databases and containers; owned ones lead with their project and link to their entity page, or their hub tab for a domain", () => {
    const byGroup = (g: string) => registry().filter((e) => e.group === g && !e.id.startsWith("project-tab:")).map((e) => [e.label, e.hint, e.href]);
    expect(byGroup("Projects")).toEqual([
      ["shop", "2 apps on 1 server", "/projects/shop"],
      ["blog", "1 app on 1 server", "/projects/blog"],
    ]);
    expect(byGroup("Servers")).toEqual([
      ["prod", "https://prod.example.com:8443", "/servers/s1"],
      ["edge", "http://10.0.0.2:8443", "/servers/s2"],
    ]);
    expect(byGroup("Apps")).toEqual([
      ["web", "shop · production · prod", "/servers/s1/apps/web"],
      ["api", "shop · production · prod", "/servers/s1/apps/api"],
      ["blog", "blog · production · edge", "/servers/s2/apps/blog"],
    ]);
    expect(byGroup("Domains")).toEqual([
      ["shop.example.com", "shop · prod · web", "/projects/shop/domains"],
      ["orphan.example.com", "edge · site", "/servers/s2/proxy"],
    ]);
    expect(byGroup("Jobs")).toEqual([
      ["nightly", "shop · prod · 0 3 * * *", "/servers/s1/jobs/nightly"],
      ["busy", "prod · * * * * *", "/servers/s1/jobs/busy"],
      ["ping", "edge · */5 * * * *", "/servers/s2/jobs/ping"],
    ]);
    expect(byGroup("Databases")).toEqual([
      ["kv-pg", "shop · prod · postgres@db:5432/shop", "/servers/s1/databases/kv-pg"],
      ["scratch", "edge · postgres@db:5432/x", "/servers/s2/databases/scratch"],
    ]);
    expect(byGroup("Containers").map((c) => c[2])).toEqual(["/servers/s1/containers/web-blue", "/servers/s1/containers/old", "/servers/s1/containers/pg", "/servers/s2/containers/ghost"]);
  });

  it("sets the project in the scope of what is owned only", () => {
    expect(find("job:s1:nightly")?.scope).toEqual({ server: "s1", job: "nightly", project: "shop" });
    expect(find("job:s1:busy")?.scope).toEqual({ server: "s1", job: "busy" });
    expect(find("database:s2:scratch")?.scope).toEqual({ server: "s2" });
    expect(find("domain:s1:shop.example.com")?.scope).toEqual({ server: "s1", project: "shop" });
  });

  it("offers the actions that navigate to the page whose dialog asks: deploy, roll back, run, restart, start", () => {
    const actions = registry().filter((e) => e.group === "Actions");
    expect(actions.map((a) => [a.label, a.href])).toEqual([
      ["New project", "/projects/new"],
      ["Add job", "/jobs"],
      ["Add database", "/databases"],
      ["Deploy web…", "/servers/s1/apps/web?deploy="],
      ["Roll back web…", "/servers/s1/apps/web?rollback=1"],
      ["Deploy api…", "/servers/s1/apps/api?deploy="],
      ["Run job nightly…", "/servers/s1/jobs/nightly?runnow=1"],
      ["Restart web-blue…", "/servers/s1/containers/web-blue?restart=1"],
      ["Start old", "/servers/s1/containers/old?start=1"],
    ]);
  });

  it("offers no action where it could not be done: a read-only server, a job already running, a container Keelson does not manage, an app never deployed", () => {
    const labelsOf = labels(registry().filter((e) => e.group === "Actions"));
    for (const missing of ["Deploy blog…", "Roll back blog…", "Run job ping…", "Run job busy…", "Restart pg…", "Restart ghost…", "Roll back api…"]) expect(labelsOf).not.toContain(missing);
  });

  it("never builds an action that changes anything: only page links", () => {
    for (const a of registry().filter((e) => e.group === "Actions")) {
      expect(a.command).toBeUndefined();
      expect(a.href).toMatch(/^\/(servers\/[^/]+\/(apps|jobs|containers)\/[^/?]+\?(deploy=|rollback=1|runnow=1|restart=1|start=1)|projects\/new|jobs|databases)$/);
    }
    expect(ACTION_HREFS.deploy("s", "a b")).toBe("/servers/s/apps/a%20b?deploy=");
  });

  it("has the preferences as commands that stay on the page", () => {
    const prefs = registry().filter((e) => e.group === "Preferences");
    expect(prefs.map((p) => p.command)).toEqual(["shortcuts", "theme-light", "theme-dark", "theme-system", "sign-out"]);
    expect(prefs.every((p) => p.href === undefined)).toBe(true);
    expect(prefs[0].shortcut).toEqual(["?"]);
  });

  it("builds from an empty fleet: only pages and preferences", () => {
    expect(new Set(buildRegistry(emptyIndex()).map((e) => e.group))).toEqual(new Set(["Go to", "Actions", "Preferences"]));
  });

  it("keeps ids unique and stable", () => {
    const ids = registry().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(find("app:s1:web")?.href).toBe("/servers/s1/apps/web");
  });
});

describe("fuzzyScore and scoreEntry", () => {
  it("ranks exact over prefix over word start over inside over letters in order, and 0 for no match", () => {
    const scores = [fuzzyScore("web", "web"), fuzzyScore("web", "web-blue"), fuzzyScore("web", "my-web"), fuzzyScore("web", "cobweb"), fuzzyScore("wbl", "web-blue"), fuzzyScore("xyz", "web-blue")];
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
    expect(scores[3]).toBeGreaterThan(scores[4]);
    expect(scores[4]).toBeGreaterThan(0);
    expect(scores[5]).toBe(0);
  });
  it("does not let one or two letters match anywhere in a long text: letters in order need three", () => {
    expect(fuzzyScore("wb", "web-blue")).toBe(0);
    expect(fuzzyScore("zq", "a-long-zebra-quiet-name")).toBe(0);
    expect(fuzzyScore("e", "web-blue")).toBeGreaterThan(0); // a plain substring still counts
  });
  it("needs every word of the query to match something of the entry", () => {
    const e = find("action:deploy:s1:web") as PaletteEntry;
    expect(scoreEntry(e, "deploy web")).toBeGreaterThan(0);
    expect(scoreEntry(e, "deploy prod")).toBeGreaterThan(0); // the server is in its hint
    expect(scoreEntry(e, "deploy nightly")).toBe(0);
    expect(scoreEntry(e, "   ")).toBe(0);
  });
  it("finds by the extra words an entry carries", () => {
    expect(scoreEntry(find("go:api-tokens") as PaletteEntry, "github")).toBeGreaterThan(0);
    expect(scoreEntry(find("domain:s1:shop.example.com") as PaletteEntry, "proxy")).toBeGreaterThan(0);
  });
});

describe("rank", () => {
  it("puts the exact name first and the action for it right behind", () => {
    const out = rank(registry(), "web");
    expect(out[0].label).toBe("web");
    expect(labels(out)).toEqual(expect.arrayContaining(["Deploy web…", "Roll back web…", "web-blue", "Restart web-blue…"]));
    const ids = out.map((e) => e.id);
    expect(ids.indexOf("app:s1:web")).toBeLessThan(ids.indexOf("action:deploy:s1:web"));
    expect(ids.indexOf("action:deploy:s1:web")).toBeLessThan(ids.indexOf("container:s1:web-blue") === -1 ? Infinity : ids.indexOf("container:s1:web-blue") + 100);
  });

  it("puts the action first when the query asks for one", () => {
    expect(rank(registry(), "deploy web")[0].label).toBe("Deploy web…");
    expect(rank(registry(), "restart")[0].label).toBe("Restart web-blue…");
    expect(rank(registry(), "run job")[0].label).toBe("Run job nightly…");
    expect(rank(registry(), "roll back")[0].label).toBe("Roll back web…");
  });

  it("finds a domain by its hostname and sends it to its project's Domains tab", () => {
    const out = rank(registry(), "shop.example");
    expect(out[0]).toMatchObject({ group: "Domains", href: "/projects/shop/domains" });
  });

  it("finds a project's tab by the project and the tab noun", () => {
    expect(rank(registry(), "shop variables")[0]).toMatchObject({ id: "project-tab:shop:variables", href: "/projects/shop/variables" });
    expect(rank(registry(), "shop cron")[0].href).toBe("/projects/shop/jobs");
  });

  it("matches loosely: letters in order, a server's name, a database's name", () => {
    expect(rank(registry(), "ngt")[0].label).toBe("nightly");
    expect(labels(rank(registry(), "edge"))).toEqual(expect.arrayContaining(["edge", "blog"]));
    expect(rank(registry(), "kv-pg")[0].group).toBe("Databases");
  });

  it("puts what concerns the page you are on above the rest, for the same words", () => {
    const plain = rank(registry(), "deploy").map((e) => e.label);
    expect(plain.indexOf("Deploy api…")).toBeGreaterThan(plain.indexOf("Deploy web…") - 1);
    const onApi = rank(registry(), "deploy", { context: contextOf("/servers/s1/apps/api") }).map((e) => e.label);
    expect(onApi[0]).toBe("Deploy api…");
  });

  it("puts what was used lately first, the latest first", () => {
    const out = rank(registry(), "e", { recent: ["server:s2", "go:settings"] });
    expect(out[0].id).toBe("server:s2");
    // For the same match, the one used last comes first.
    const twins: PaletteEntry[] = ["x", "y", "z"].map((id) => ({ id, group: "Apps", label: `alpha ${id}` }));
    expect(rank(twins, "alpha").map((e) => e.id)).toEqual(["x", "y", "z"]);
    expect(rank(twins, "alpha", { recent: ["z"] }).map((e) => e.id)).toEqual(["z", "x", "y"]);
    expect(rank(twins, "alpha", { recent: ["y", "z"] }).map((e) => e.id)).toEqual(["y", "z", "x"]);
  });

  it("returns nothing for what matches nothing, and at most `limit`", () => {
    expect(rank(registry(), "zzzzqqq")).toEqual([]);
    expect(rank(registry(), "e", { limit: 3 })).toHaveLength(3);
  });

  it("groups the ranked list in the order the groups first appear", () => {
    const grouped = groupRanked(rank(registry(), "deploy web"));
    expect(grouped[0].group).toBe("Actions");
    expect(grouped.map((g) => g.group)).toEqual([...new Set(grouped.map((g) => g.group))]);
  });

  it("copes with a large fleet: ranks thousands of entries and stays bounded", () => {
    const big = emptyIndex();
    big.servers = [{ ...prod, url: "u" }];
    for (let i = 0; i < 2000; i++) big.containers.push({ server: prod, name: `c-${i}`, running: true, managed: true });
    const all = buildRegistry(big);
    expect(all.length).toBeGreaterThan(4000);
    expect(rank(all, "c-19").length).toBeLessThanOrEqual(50);
    expect(rank(all, "c-1999")[0].label).toBe("c-1999");
  });
});

describe("contextOf and contextActions", () => {
  it("reads the subject of the page from its path", () => {
    expect(contextOf("/servers/s1/apps/web")).toEqual({ server: "s1", app: "web" });
    expect(contextOf("/servers/s1/apps/a%20b/source")).toEqual({ server: "s1", app: "a b" });
    expect(contextOf("/servers/s1/jobs/nightly")).toEqual({ server: "s1", job: "nightly" });
    expect(contextOf("/servers/s1/containers/web-blue")).toEqual({ server: "s1", container: "web-blue" });
    expect(contextOf("/servers/s1")).toEqual({ server: "s1" });
    expect(contextOf("/servers/s1/proxy")).toEqual({ server: "s1" });
    expect(contextOf("/projects/shop")).toEqual({ project: "shop" });
    expect(contextOf("/servers/new")).toEqual({});
    expect(contextOf("/activity")).toEqual({});
  });
  it("offers on an app's page the actions for that app, on a job's page that job, on a container's that container", () => {
    expect(labels(contextActions(registry(), contextOf("/servers/s1/apps/web")))).toEqual(["Deploy web…", "Roll back web…", "Restart web-blue…"]);
    expect(labels(contextActions(registry(), contextOf("/servers/s1/jobs/nightly")))).toEqual(["Run job nightly…"]);
    expect(labels(contextActions(registry(), contextOf("/servers/s1/containers/old")))).toEqual(["Start old"]);
    expect(labels(contextActions(registry(), contextOf("/projects/shop")))).toEqual(["Deploy web…", "Roll back web…", "Deploy api…", "Run job nightly…"]);
  });
  it("offers on a server's page the actions of that server, bounded, and none elsewhere", () => {
    expect(contextActions(registry(), contextOf("/servers/s1"), 3)).toHaveLength(3);
    expect(contextActions(registry(), contextOf("/servers/s2"))).toEqual([]);
    expect(contextActions(registry(), contextOf("/activity"))).toEqual([]);
  });
  it("knows the project, server and entity of every page that names one", () => {
    expect(contextOf("/projects/shop/variables")).toEqual({ project: "shop" });
    expect(contextOf("/projects/a%20b/apps")).toEqual({ project: "a b" });
    expect(contextOf("/servers/s1/databases/kv-pg")).toEqual({ server: "s1" });
    expect(contextOf("/servers/s1/deployments/abc")).toEqual({ server: "s1" });
    expect(contextOf("/jobs")).toEqual({});
    expect(contextOf("/databases")).toEqual({});
  });
  it("offers the create actions only where they apply: New project always, the project's own on its pages", () => {
    const ids = (path: string) => buildRegistry(index(), contextOf(path)).filter((e) => e.id.startsWith("action:add") || e.id === "action:new-project").map((e) => e.id);
    expect(ids("/activity")).toEqual(["action:new-project", "action:add-job", "action:add-database"]);
    expect(ids("/projects/shop")).toEqual(["action:new-project", "action:add-app:shop", "action:add-environment:shop", "action:add-job", "action:add-database"]);
    // On the page of an app or job of a project, the project's actions.
    expect(ids("/servers/s1/apps/web")).toContain("action:add-app:shop");
    expect(ids("/servers/s1/jobs/nightly")).toContain("action:add-app:shop");
    expect(ids("/servers/s2/apps/blog")).toContain("action:add-app:blog");
    expect(ids("/servers/s1")).not.toContain("action:add-app:shop");
  });
  it("sends Add app and Add environment to the Apps tab dialogs", () => {
    const entries = buildRegistry(index(), { project: "shop" });
    expect(entries.find((e) => e.id === "action:add-app:shop")?.href).toBe("/projects/shop/apps?add=app");
    expect(entries.find((e) => e.id === "action:add-environment:shop")?.href).toBe("/projects/shop/apps?add=environment");
  });
  it("adds a job or a database on the project's first server that can be changed, returning to the project's tab; else to the global list", () => {
    const entries = buildRegistry(index(), { project: "shop" });
    expect(entries.find((e) => e.id === "action:add-job")?.href).toBe(`/servers/s1/config/jobs/new?from=${encodeURIComponent("/projects/shop/jobs")}`);
    expect(entries.find((e) => e.id === "action:add-database")?.href).toBe(`/servers/s1/config/databases/new?from=${encodeURIComponent("/projects/shop/databases")}`);
    // blog only lives on the read-only server
    const blog = buildRegistry(index(), { project: "blog" });
    expect(blog.find((e) => e.id === "action:add-job")?.href).toBe("/jobs?project=blog");
    expect(blog.find((e) => e.id === "action:add-database")?.href).toBe("/databases?project=blog");
    // no project: the global lists
    expect(registry().find((e) => e.id === "action:add-job")?.href).toBe("/jobs");
    expect(registry().find((e) => e.id === "action:add-database")?.href).toBe("/databases");
  });
  it("ranks what the project owns first on its hub, and lists its create actions first", () => {
    const context = { project: "shop" };
    const entries = buildRegistry(index(), context);
    expect(rank(entries, "n", { context })[0].scope?.project).toBe("shop");
    expect(contextActions(entries, context, 4).map((e) => e.id)).toEqual(["action:add-app:shop", "action:add-environment:shop", "action:add-job", "action:add-database"]);
  });
});

describe("initialGroups", () => {
  it("shows recent uses first, then the page's actions, the pages, the projects, a few servers and the preferences", () => {
    const groups = initialGroups(registry(), contextOf("/servers/s1/apps/web"), ["app:s1:api", "gone:x"]);
    expect(groups.map((g) => g.group)).toEqual(["Recent", "Actions", "Go to", "Projects", "Servers", "Preferences"]);
    expect(labels(groups[0].entries)).toEqual(["api"]);
    expect(labels(groups[1].entries)).toEqual(["Deploy web…", "Roll back web…", "Restart web-blue…"]);
  });
  it("does not list a recent entry twice", () => {
    const groups = initialGroups(registry(), contextOf("/servers/s1/apps/web"), ["action:deploy:s1:web", "go:home"]);
    expect(groups.find((g) => g.group === "Actions")?.entries.map((e) => e.label)).toEqual(["Roll back web…", "Restart web-blue…"]);
    expect(groups.find((g) => g.group === "Go to")?.entries.map((e) => e.label)).not.toContain("Home");
  });
  it("is just pages and preferences for an empty fleet", () => {
    expect(initialGroups(buildRegistry(emptyIndex()), {}, []).map((g) => g.group)).toEqual(["Go to", "Preferences"]);
  });
  it("shows the projects themselves, not their tabs, before anything is typed", () => {
    const groups = initialGroups(registry(), {}, []);
    expect(groups.map((g) => g.group)).toEqual(["Go to", "Projects", "Servers", "Preferences"]);
    expect(groups.find((g) => g.group === "Projects")?.entries.map((e) => e.href)).toEqual(["/projects/shop", "/projects/blog"]);
  });
  it("offers the create actions of the project the page is on, first", () => {
    const context = contextOf("/projects/shop/jobs");
    const groups = initialGroups(buildRegistry(index(), context), context, []);
    expect(groups[0].group).toBe("Actions");
    expect(groups[0].entries.map((e) => e.id).slice(0, 4)).toEqual(["action:add-app:shop", "action:add-environment:shop", "action:add-job", "action:add-database"]);
  });
});

describe("recent", () => {
  it("moves a used entry to the front once, and keeps a few", () => {
    let ids: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "b"]) ids = addRecent(ids, { id, group: "Apps" });
    expect(ids).toHaveLength(RECENT_MAX);
    expect(ids[0]).toBe("b");
    expect(ids.filter((i) => i === "b")).toHaveLength(1);
  });
  it("does not remember preferences", () => {
    expect(addRecent(["a"], { id: "pref:theme-dark", group: "Preferences" })).toEqual(["a"]);
  });
  it("reads what is stored defensively", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["a", 3, null, "b"]')).toEqual(["a", "b"]);
    expect(parseRecent(JSON.stringify(Array.from({ length: 20 }, (_, i) => `id${i}`)))).toHaveLength(RECENT_MAX);
  });
});
