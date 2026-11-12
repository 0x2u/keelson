import { describe, expect, it } from "vitest";
import type { AppConfig, AppStatus, ConfigModel, DatabaseStatus, JobConfig, JobStatus } from "@/lib/agent-types";
import { isProblem } from "@/lib/databases-fleet-core";
import { databaseEntryRows, jobRows, jobsNeedingLook } from "@/lib/project-hub-jobs-core";
import { attentionTabs, hubSummary, projectMembers, projectPlacements, type ServerFacts } from "@/lib/project-hub-core";
import { groupProjects, type Placement, type Project } from "@/lib/projects-core";

const srv = (id: string) => ({ id, name: `srv-${id}`, canDeploy: true });
const RUNNING = { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 };

function app(name: string, over: Partial<AppStatus> = {}): AppStatus {
  return {
    name,
    image: `ghcr.io/o/${name}`,
    project: "",
    environment: "",
    digest: "sha256:" + "a".repeat(64),
    container: { id: "c", name, image: `ghcr.io/o/${name}:v1`, created: "", tty: false, restart_count: 0, ports: [], state: RUNNING },
    last_deployment: null,
    ...over,
  } as AppStatus;
}
const job = (name: string, over: Partial<JobStatus> = {}): JobStatus => ({ name, schedule: "0 3 * * *", timezone: "UTC", kind: "host", target: "/bin/true", paused: false, running: false, ...over });
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
const backup = (name: string, over: Record<string, unknown> = {}) => ({
  schedule: "0 2 * * *",
  timezone: "UTC",
  keep: 7,
  keep_days: 0,
  paused: false,
  destination: "local:/b",
  recipients: 1,
  job: `backup-${name}`,
  next_run: null,
  last_run: null,
  ...over,
});
const containerJob = (name: string, appName: string) => job(name, { kind: "container", target: `container of ${appName}` });
const httpJob = (name: string) => job(name, { kind: "http", target: "GET http://x/y" });
const backupJob = (database: string) => job(`backup-${database}`, { kind: "backup", target: `backup of ${database}` });
const httpConfig = (name: string, bearerApp?: string): JobConfig => ({ name, schedule: "* * * * *", http: { url: "http://x/y", ...(bearerApp ? { bearer: { app: bearerApp } } : {}) } });
const appConfig = (name: string, backupDb?: string): AppConfig => ({ name, image: "i", ...(backupDb ? { release: { steps: [{ name: "backup", backup: backupDb }] } } : {}) }) as AppConfig;

function facts(serverId: string, apps: AppStatus[], over: Partial<ServerFacts> = {}): ServerFacts {
  return { server: srv(serverId), apps, jobs: [], databases: [], config: {}, ...over };
}
function projectOn(name: string, ...list: { s: string; a: AppStatus }[]): Project {
  const placements: Placement[] = list.map(({ s, a }) => ({ server: srv(s), app: { ...a, project: name }, jobs: [] }));
  const p = groupProjects(placements).find((x) => x.name === name);
  if (!p) throw new Error("no project");
  return p;
}
const names = (list: { job: JobStatus }[]) => list.map((j) => j.job.name);

describe("the operator's project: one app, container and HTTP jobs, a backup job and a database", () => {
  const apps = [app("shop"), app("other")];
  const config: ConfigModel = {
    apps: [appConfig("shop", "shop"), appConfig("other")],
    jobs: [httpConfig("analytics-purge", "shop"), httpConfig("daily-report", "shop"), httpConfig("track-shipments", "shop"), httpConfig("ping-other", "other")],
  };
  const f = facts("vps-1", apps, {
    config,
    jobs: [httpJob("analytics-purge"), httpJob("daily-report"), httpJob("track-shipments"), httpJob("ping-other"), backupJob("shop"), job("host-clean"), containerJob("other-task", "other")],
    databases: [db("shop", { backup: backup("shop") }), db("legacy")],
  });
  const project = projectOn("shop", { s: "vps-1", a: apps[0] });
  const m = projectMembers(project, [f]);

  it("attributes HTTP jobs to the app that is their bearer, and the backup job to its database", () => {
    expect(names(m.jobs)).toEqual(["analytics-purge", "daily-report", "track-shipments", "backup-shop"]);
    expect(m.jobs.map((j) => j.via)).toEqual(["http-bearer", "http-bearer", "http-bearer", "backup"]);
    expect(m.jobs[0].app).toBe("shop");
    expect(m.jobs[3].database).toBe("shop");
    expect(m.jobs[0].config?.name).toBe("analytics-purge");
  });

  it("finds the database through the release step that backs it up", () => {
    expect(m.databases).toHaveLength(1);
    expect(m.databases[0]).toMatchObject({ via: "release-backup", apps: ["shop"] });
    expect(m.databases[0].db.name).toBe("shop");
  });

  it("lists as unassigned what no app of the server claims, and never what another app's job is", () => {
    expect(m.unassignedJobs.map((j) => j.job.name)).toEqual(["host-clean"]);
    expect(m.unassignedDatabases.map((d) => d.db.name)).toEqual(["legacy"]);
  });
});

describe("jobs", () => {
  it("attributes a container job by its target, including to a preview app of the project", () => {
    const apps = [app("web"), app("web-pr-7")];
    const f = facts("1", apps, { jobs: [containerJob("migrate", "web"), containerJob("seed", "web-pr-7")] });
    const m = projectMembers(projectOn("web", { s: "1", a: apps[0] }, { s: "1", a: apps[1] }), [f]);
    expect(m.jobs.map((j) => [j.job.name, j.via, j.app])).toEqual([
      ["migrate", "container", "web"],
      ["seed", "container", "web-pr-7"],
    ]);
  });

  it("uses the configured container app when the target says nothing", () => {
    const apps = [app("web")];
    const j = job("x", { kind: "container", target: "" });
    const f = facts("1", apps, { jobs: [j], config: { jobs: [{ name: "x", schedule: "* * * * *", container: { app: "web", command: ["a"] } }] } });
    expect(projectMembers(projectOn("web", { s: "1", a: apps[0] }), [f]).jobs.map((x) => x.via)).toEqual(["container"]);
  });

  it("does not attribute an HTTP job without a bearer app, nor when the configuration is unreadable: it is unassigned", () => {
    const apps = [app("web")];
    const jobs = [httpJob("a"), httpJob("b")];
    const ok = projectMembers(projectOn("web", { s: "1", a: apps[0] }), [facts("1", apps, { jobs, config: { jobs: [httpConfig("a"), httpConfig("b", "web")] } })]);
    expect(names(ok.jobs)).toEqual(["b"]);
    expect(ok.unassignedJobs.map((j) => j.job.name)).toEqual(["a"]);
    const unreadable = projectMembers(projectOn("web", { s: "1", a: apps[0] }), [facts("1", apps, { jobs, config: null })]);
    expect(unreadable.jobs).toEqual([]);
    expect(unreadable.unassignedJobs).toHaveLength(2);
  });

  it("leaves a job of another project's app on the same server to that project: neither a member nor unassigned", () => {
    const apps = [app("web"), app("blog")];
    const f = facts("1", apps, { jobs: [containerJob("blog-task", "blog")] });
    const m = projectMembers(projectOn("web", { s: "1", a: apps[0] }), [f]);
    expect(m.jobs).toEqual([]);
    expect(m.unassignedJobs).toEqual([]);
  });

  it("is unassigned when the app it names does not exist on the server", () => {
    const apps = [app("web")];
    const f = facts("1", apps, { jobs: [containerJob("ghost", "gone")] });
    expect(projectMembers(projectOn("web", { s: "1", a: apps[0] }), [f]).unassignedJobs.map((j) => j.job.name)).toEqual(["ghost"]);
  });

  it("does not attribute a job across servers: an app of the same name elsewhere does not claim it", () => {
    const a = app("web");
    const f1 = facts("1", [a], { jobs: [containerJob("t", "web")] });
    const f2 = facts("2", [app("web2")], { jobs: [containerJob("t", "web")] });
    const m = projectMembers(projectOn("web", { s: "1", a }), [f1, f2]);
    expect(m.jobs.map((j) => j.server.id)).toEqual(["1"]);
    expect(m.unassignedJobs).toEqual([]);
  });

  it("follows a backup job to its database by the job named in the backup, or by the backup-<db> name", () => {
    const a = app("web");
    const f = facts("1", [a], {
      config: { apps: [appConfig("web", "main")] },
      databases: [db("main", { backup: backup("main", { job: "nightly-main" }) })],
      jobs: [job("nightly-main", { kind: "backup" }), backupJob("main")],
    });
    expect(names(projectMembers(projectOn("web", { s: "1", a }), [f]).jobs)).toEqual(["nightly-main", "backup-main"]);
  });

  it("is unassigned for a backup job whose database is unknown or has no owner", () => {
    const a = app("web");
    const f = facts("1", [a], { databases: [db("orphan")], jobs: [backupJob("orphan"), backupJob("missing")] });
    const m = projectMembers(projectOn("web", { s: "1", a }), [f]);
    expect(m.jobs).toEqual([]);
    expect(m.unassignedJobs.map((j) => j.job.name)).toEqual(["backup-orphan", "backup-missing"]);
  });
});

describe("databases", () => {
  it("belongs to the app it was created for (managed), and says so", () => {
    const a = app("web");
    const f = facts("1", [a], { databases: [db("web-db", { managed: true, app: "web", env_key: "DATABASE_URL" })], config: { databases: [{ name: "web-db", host: "h", database: "d", user: "u" }] } });
    const m = projectMembers(projectOn("web", { s: "1", a }), [f]);
    expect(m.databases[0]).toMatchObject({ via: "managed-app", apps: ["web"] });
    expect(m.databases[0].config?.name).toBe("web-db");
  });

  it("ignores a managed database whose app is not on the server", () => {
    const a = app("web");
    const f = facts("1", [a], { databases: [db("x", { managed: true, app: "gone" })] });
    const m = projectMembers(projectOn("web", { s: "1", a }), [f]);
    expect(m.databases).toEqual([]);
    expect(m.unassignedDatabases.map((d) => d.db.name)).toEqual(["x"]);
  });

  it("is listed under each project that uses it, with only that project's apps", () => {
    const apps = [app("shop"), app("admin")];
    const f = facts("1", apps, { config: { apps: [appConfig("shop", "main"), appConfig("admin", "main")] }, databases: [db("main")] });
    const shop = projectMembers(projectOn("shop", { s: "1", a: apps[0] }), [f]);
    const admin = projectMembers(projectOn("admin", { s: "1", a: apps[1] }), [f]);
    expect(shop.databases.map((d) => [d.db.name, d.apps])).toEqual([["main", ["shop"]]]);
    expect(admin.databases.map((d) => [d.db.name, d.apps])).toEqual([["main", ["admin"]]]);
    expect(shop.unassignedDatabases).toEqual([]);
  });

  it("prefers managed-app when the project owns the managed app, and lists both apps of the project once", () => {
    const apps = [app("web"), app("web-pr-1")];
    const f = facts("1", apps, { config: { apps: [appConfig("web-pr-1", "d")] }, databases: [db("d", { managed: true, app: "web" })] });
    const m = projectMembers(projectOn("web", { s: "1", a: apps[0] }, { s: "1", a: apps[1] }), [f]);
    expect(m.databases).toHaveLength(1);
    expect(m.databases[0]).toMatchObject({ via: "managed-app", apps: ["web", "web-pr-1"] });
  });

  it("is attributed to a preview app through its release step", () => {
    const apps = [app("web"), app("web-pr-3")];
    const f = facts("1", apps, { config: { apps: [appConfig("web-pr-3", "pr-db")] }, databases: [db("pr-db")] });
    const m = projectMembers(projectOn("web", { s: "1", a: apps[0] }, { s: "1", a: apps[1] }), [f]);
    expect(m.databases[0]).toMatchObject({ via: "release-backup", apps: ["web-pr-3"] });
  });

  it("falls back to managed databases only when the configuration is unreadable, and unassigns the rest", () => {
    const a = app("web");
    const f = facts("1", [a], { config: null, databases: [db("m", { managed: true, app: "web" }), db("r")] });
    const m = projectMembers(projectOn("web", { s: "1", a }), [f]);
    expect(m.databases.map((d) => d.db.name)).toEqual(["m"]);
    expect(m.databases[0].config).toBeUndefined();
    expect(m.unassignedDatabases.map((d) => d.db.name)).toEqual(["r"]);
  });
});

describe("two servers and servers without an app of the project", () => {
  it("derives members per server and ignores servers that hold none of the project's apps", () => {
    const a1 = app("web");
    const a2 = app("web", { environment: "staging" });
    const project = projectOn("web", { s: "1", a: a1 }, { s: "2", a: a2 });
    const f1 = facts("1", [a1], { jobs: [containerJob("t1", "web")], databases: [db("d1", { managed: true, app: "web" })] });
    const f2 = facts("2", [a2], { jobs: [containerJob("t2", "web")] });
    const elsewhere = facts("3", [app("zzz")], { jobs: [job("h")], databases: [db("d3")] });
    const m = projectMembers(project, [f1, f2, elsewhere]);
    expect(m.jobs.map((j) => [j.server.id, j.job.name])).toEqual([["1", "t1"], ["2", "t2"]]);
    expect(m.databases.map((d) => d.server.id)).toEqual(["1"]);
    expect(m.unassignedJobs).toEqual([]);
    expect(m.unassignedDatabases).toEqual([]);
  });

  it("lists a database and a job labelled with the project on a server that runs none of its apps", () => {
    const a = app("web");
    const project = projectOn("web", { s: "1", a });
    const elsewhere = facts("2", [app("zzz")], {
      jobs: [job("labelled", { project: "web" }), job("other")],
      databases: [db("mine", { project: "web" }), db("loose")],
    });
    const m = projectMembers(project, [facts("1", [a]), elsewhere]);
    expect(m.databases.map((d) => [d.server.id, d.db.name, d.via])).toEqual([["2", "mine", "label"]]);
    expect(m.jobs.map((j) => j.job.name)).toEqual(["labelled"]);
    expect(m.unassignedDatabases).toEqual([]);
    expect(m.unassignedJobs).toEqual([]);
  });

  it("returns nothing when no server answered", () => {
    const a = app("web");
    expect(projectMembers(projectOn("web", { s: "1", a }), [])).toEqual({ jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [] });
  });
});

describe("hubSummary and attentionTabs", () => {
  const NOW = Date.parse("2026-10-23T12:00:00Z");
  const HOUR = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const a = app("web", { domains: ["a.example.com", "b.example.com"] });
  const stopped = app("web-stg", { environment: "staging", domains: ["a.example.com"], container: { ...(app("x").container as NonNullable<AppStatus["container"]>), state: { ...RUNNING, running: false, status: "exited" } } });
  const project = projectOn("web", { s: "1", a }, { s: "1", a: stopped });
  const empty = { jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [] };
  const run = (status: string) => ({ id: "r", job: "j", trigger: "schedule" as const, status: status as never, started_at: iso(NOW - HOUR) });
  const membersOf = (over: Partial<ServerFacts>) => projectMembers(project, [facts("1", [a, stopped], over)]);
  const dbRun = (status: string, startedAt: number) => ({ id: "1", status: status as never, started_at: iso(startedAt) });
  const managed = (name: string, b: DatabaseStatus["backup"]) => db(name, { managed: true, app: "web", backup: b });

  it("counts apps, domains once, and says what is down", () => {
    const s = hubSummary(project, empty, NOW);
    expect(s.apps).toEqual({ count: 2, down: 1 });
    expect(s.domains.count).toBe(2);
    expect(projectPlacements(project)).toHaveLength(2);
  });

  it("flags a job that never ran exactly as the Jobs tab does", () => {
    const m = membersOf({ jobs: [containerJob("fresh", "web"), { ...containerJob("done", "web"), last_run: run("succeeded") }] });
    const s = hubSummary(project, m, NOW);
    expect(s.jobs).toEqual({ count: 2, failing: 0, neverRun: 1, paused: 0, look: jobsNeedingLook(jobRows(m.jobs), NOW) });
    expect(s.jobs.look).toBe(1);
    expect(attentionTabs(s, 0)).toEqual(["apps", "jobs"]); // apps: the fixture's staging app is stopped
  });

  it("does not flag a job that is scheduled and has not reached its first run, but flags one whose time passed", () => {
    const soon = { ...containerJob("soon", "web"), next_run: iso(NOW + HOUR) };
    const late = { ...containerJob("late", "web"), next_run: iso(NOW - HOUR) };
    const s = hubSummary(project, membersOf({ jobs: [soon, late] }), NOW);
    expect(s.jobs).toMatchObject({ count: 2, neverRun: 1, look: 1 });
  });

  it("flags a failing job, counts a paused one apart, and does not flag the paused one", () => {
    const m = membersOf({ jobs: [{ ...containerJob("bad", "web"), last_run: run("failed") }, { ...containerJob("off", "web"), paused: true, last_run: run("failed") }, { ...containerJob("ok", "web"), last_run: run("succeeded") }] });
    const s = hubSummary(project, m, NOW);
    expect(s.jobs).toEqual({ count: 3, failing: 1, neverRun: 0, paused: 1, look: 1 });
  });

  it("does not flag a project of healthy jobs", () => {
    const m = membersOf({ jobs: [{ ...containerJob("ok", "web"), last_run: run("succeeded") }, { ...containerJob("off", "web"), paused: true }] });
    const s = hubSummary(project, m, NOW);
    expect(s.jobs.look).toBe(0);
    expect(attentionTabs(s, 0)).toEqual(["apps"]);
  });

  it("does not flag a database waiting for its first scheduled backup, but does not call it backed up either", () => {
    const m = membersOf({ databases: [managed("d", backup("d", { next_run: iso(NOW + HOUR) }))] });
    const s = hubSummary(project, m, NOW);
    expect(s.databases).toEqual({ count: 1, failed: 0, overdue: 0, unprotected: 0, pending: 1, look: 0 });
    expect(s.databases.look).toBe(databaseEntryRows(m.databases, NOW).filter((r) => isProblem(r.state)).length);
  });

  it("flags a failed backup, an overdue one, no schedule at all, none configured, and paused ones", () => {
    const m = membersOf({
      databases: [
        managed("failed", backup("failed", { last_run: dbRun("failed", NOW - HOUR) })),
        managed("overdue", backup("overdue", { last_run: dbRun("succeeded", NOW - 10 * 24 * HOUR) })),
        managed("never", backup("never", { next_run: null })),
        managed("none", null),
        managed("paused", backup("paused", { paused: true })),
        managed("fine", backup("fine", { last_run: dbRun("succeeded", NOW - HOUR) })),
      ],
    });
    const s = hubSummary(project, m, NOW);
    expect(s.databases).toEqual({ count: 6, failed: 1, overdue: 2, unprotected: 2, pending: 0, look: 5 });
    expect(attentionTabs(s, 0)).toEqual(["apps", "databases"]);
  });

  it("marks apps when a server did not answer, and nothing when all is well", () => {
    const calm = hubSummary(projectOn("web", { s: "1", a }), empty, NOW);
    expect(attentionTabs(calm, 0)).toEqual([]);
    expect(attentionTabs(calm, 1)).toEqual(["apps"]);
  });
});
