import { describe, expect, it } from "vitest";
import type { AppStatus, DatabaseStatus, JobConfig, JobStatus } from "@/lib/agent-types";
import { hubCrumbs, projectOfReturnPath, returnCrumbs, safeReturnPath } from "@/lib/nav-core";
import {
  addServers,
  addTargets,
  filterDatabases,
  filterJobs,
  filterUnanswered,
  fleetLists,
  listHref,
  listScope,
  parseListFilter,
  type ListFacts,
} from "@/lib/resource-lists-core";

const srv = (id: string, canDeploy = true) => ({ id, name: `srv-${id}`, canDeploy });
const RUNNING = { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 };

const app = (name: string, project = ""): AppStatus =>
  ({
    name,
    image: `ghcr.io/o/${name}`,
    project,
    environment: "",
    digest: "sha256:" + "a".repeat(64),
    container: { id: "c", name, image: `ghcr.io/o/${name}:v1`, created: "", tty: false, restart_count: 0, ports: [], state: RUNNING },
    last_deployment: null,
  }) as AppStatus;
const job = (name: string, over: Partial<JobStatus> = {}): JobStatus => ({ name, schedule: "0 3 * * *", timezone: "UTC", kind: "host", target: "/bin/true", paused: false, running: false, ...over });
const bearerJob = (name: string): JobStatus => job(name, { kind: "http", target: "GET http://x/y" });
const bearerConfig = (name: string, appName: string): JobConfig => ({ name, schedule: "* * * * *", http: { url: "http://x/y", bearer: { app: appName } } });
const db = (name: string, over: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "localhost",
  port: 5432,
  database: name,
  user: name,
  version: 16,
  network: "",
  has_password: true,
  backup: null,
  ...over,
});

const facts = (id: string, over: Partial<ListFacts> = {}): ListFacts => ({ server: srv(id), reachable: true, apps: [], jobs: [], databases: [], config: null, ...over });

describe("the lists across the servers", () => {
  const lists = fleetLists([
    facts("a", {
      apps: [app("shop", "shop")],
      jobs: [bearerJob("purge"), job("host-clean"), job("labelled", { project: "other" })],
      databases: [db("shop-db", { app: "shop", managed: true }), db("legacy")],
      config: { jobs: [bearerConfig("purge", "shop")] },
    }),
    facts("b", { server: srv("b", false), apps: [app("blog")], jobs: [job("tick")], databases: [] }),
  ]);

  it("gives each job and database the project a rule or a label says, and none to what nothing claims", () => {
    const byName = Object.fromEntries(lists.jobs.map((j) => [`${j.server.id}/${j.job.name}`, j.project]));
    expect(byName).toEqual({ "a/purge": "shop", "a/host-clean": undefined, "a/labelled": "other", "b/tick": undefined });
    expect(lists.databases.map((d) => [d.db.name, d.project])).toEqual([["shop-db", "shop"], ["legacy", undefined]]);
  });

  it("keeps why a job belongs to its project, for the project's table", () => {
    const purge = lists.jobs.find((j) => j.job.name === "purge");
    expect(purge?.hub).toMatchObject({ via: "http-bearer", app: "shop" });
    expect(lists.jobs.find((j) => j.job.name === "labelled")?.hub).toBeUndefined();
  });

  it("names the projects, the servers, and where a project's own things can be added", () => {
    expect(lists.projects).toEqual(["blog", "other", "shop"]);
    expect(lists.servers.map((s) => s.id)).toEqual(["a", "b"]);
    expect(lists.projectServers.shop.map((s) => s.id)).toEqual(["a"]);
    expect(addServers(lists, { project: "shop" }).map((s) => s.id)).toEqual(["a"]);
    expect(addServers(lists, { project: "nope" }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(addServers(lists, {}).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("separates a server that did not answer, or whose jobs failed, from the ones that did: unknown, not empty", () => {
    const partial = fleetLists([
      facts("a", { jobs: [job("x")], databases: [db("d")] }),
      { server: srv("down"), reachable: false, reason: "connect ECONNREFUSED", config: null },
      facts("odd", { errors: { jobs: "boom" }, databases: [db("e")] }),
    ]);
    expect(partial.jobs.map((j) => j.job.name)).toEqual(["x"]);
    expect(partial.unansweredJobs).toEqual([
      { id: "down", name: "srv-down", reason: "connect ECONNREFUSED" },
      { id: "odd", name: "srv-odd", reason: "boom" },
    ]);
    expect(partial.unansweredDatabases).toEqual([{ id: "down", name: "srv-down", reason: "connect ECONNREFUSED" }]);
    expect(partial.databases.map((d) => d.db.name)).toEqual(["d", "e"]);
  });
});

describe("the filter in the address", () => {
  it("reads ?server= and ?project=, takes the first of a repeated one and ignores empty ones", () => {
    expect(parseListFilter({ server: "s1", project: ["p", "q"] })).toEqual({ server: "s1", project: "p" });
    expect(parseListFilter({ server: "", other: "x" })).toEqual({});
  });

  it("writes it back, encoded, and says what the table is about", () => {
    expect(listHref("jobs")).toBe("/jobs");
    expect(listHref("databases", { server: "a b", project: "shop" })).toBe("/databases?server=a+b&project=shop");
    expect(listScope({})).toBe("fleet");
    expect(listScope({ project: "p" })).toBe("project");
    expect(listScope({ server: "s", project: "p" })).toBe("server");
  });

  const lists = fleetLists([
    facts("a", { apps: [app("shop", "shop")], jobs: [bearerJob("purge"), job("clean")], databases: [db("shop-db", { app: "shop", managed: true })], config: { jobs: [bearerConfig("purge", "shop")] } }),
    facts("b", { jobs: [job("tick")], databases: [db("other")] }),
  ]);

  it("narrows by server, by project, and by both", () => {
    expect(filterJobs(lists.jobs, { server: "a" }).map((j) => j.job.name)).toEqual(["purge", "clean"]);
    expect(filterJobs(lists.jobs, { project: "shop" }).map((j) => j.job.name)).toEqual(["purge"]);
    expect(filterJobs(lists.jobs, { server: "b", project: "shop" })).toEqual([]);
    expect(filterDatabases(lists.databases, { project: "shop" }).map((d) => d.db.name)).toEqual(["shop-db"]);
    expect(filterDatabases(lists.databases, {})).toHaveLength(2);
  });

  it("keeps every unanswered server unless the list is narrowed to one server", () => {
    const unanswered = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(filterUnanswered(unanswered, {})).toHaveLength(2);
    expect(filterUnanswered(unanswered, { project: "p" })).toHaveLength(2);
    expect(filterUnanswered(unanswered, { server: "b" })).toEqual([{ id: "b", name: "B" }]);
  });
});

describe("Add", () => {
  const servers = [srv("a"), srv("b", false)];

  it("opens the configuration form of each server, returning to the list and carrying the project", () => {
    const targets = addTargets("job", servers, "/jobs?project=shop");
    expect(targets.map((t) => t.server.id)).toEqual(["a", "b"]);
    const href = new URL(targets[0].href, "http://x");
    expect(href.pathname).toBe("/servers/a/config/jobs/new");
    expect(href.searchParams.get("from")).toBe("/jobs?project=shop");
    expect(new URL(addTargets("database", servers, "/databases", {})[1].href, "http://x").pathname).toBe("/servers/b/config/databases/new");
  });

  it("offers only the server the list is narrowed to", () => {
    expect(addTargets("job", servers, "/jobs?server=b", { server: "b" }).map((t) => t.server.id)).toEqual(["b"]);
  });

  it("is a return path the forms accept, and the form's project comes from it", () => {
    const from = "/jobs?project=shop&server=a";
    expect(safeReturnPath(from)).toBe(from);
    expect(projectOfReturnPath(from)).toBe("shop");
    expect(projectOfReturnPath("/databases?server=a")).toBeNull();
    expect(projectOfReturnPath("/projects/shop/jobs")).toBe("shop");
    expect(returnCrumbs(from)).toEqual(hubCrumbs("shop", { label: "Jobs", href: from }));
    expect(returnCrumbs("/databases?project=shop")?.map((c) => c.label)).toEqual(["Projects", "shop", "Databases"]);
    expect(returnCrumbs("/jobs?server=a")).toBeNull();
  });

  it("still refuses everything that is not this site's project or list path", () => {
    for (const bad of ["/jobsx", "/jobs//evil.example", "//evil.example/jobs", "https://evil.example/jobs", "/jobs/../servers", "/databases?x=\\", "/servers/a/jobs"]) {
      expect(safeReturnPath(bad), bad).toBeNull();
    }
  });
});
