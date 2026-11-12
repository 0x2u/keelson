import { describe, expect, it } from "vitest";
import type { AppConfig, AppStatus, ConfigModel, DatabaseStatus, JobConfig, JobStatus } from "@/lib/agent-types";
import { hasHubPages, noFacts, ownerOfApp, ownerOfContainer, ownerOfDatabase, ownerOfJob, type OwnerFacts } from "@/lib/owner-core";
import { projectMembers } from "@/lib/project-hub-core";
import { groupProjects } from "@/lib/projects-core";

const app = (name: string, over: Partial<AppStatus> = {}): AppStatus => ({ name, image: `ghcr.io/o/${name}`, project: "", environment: "", digest: "", container: null, last_deployment: null, ...over });
const job = (name: string, over: Partial<JobStatus> = {}): JobStatus => ({ name, schedule: "0 3 * * *", timezone: "UTC", kind: "host", target: "/bin/true", paused: false, running: false, ...over });
const db = (name: string, over: Partial<DatabaseStatus> = {}): DatabaseStatus => ({ name, engine: "postgres", host: "localhost", port: 5432, database: name, user: name, version: 16, network: "", has_password: true, backup: null, ...over });
const containerJob = (name: string, target: string) => job(name, { kind: "container", target: `container of ${target}` });
const httpJob = (name: string) => job(name, { kind: "http", target: "GET http://x/y" });
const backupJob = (database: string) => job(`backup-${database}`, { kind: "backup", target: `backup of ${database}` });
const httpConfig = (name: string, bearerApp?: string): JobConfig => ({ name, schedule: "* * * * *", http: { url: "http://x/y", ...(bearerApp ? { bearer: { app: bearerApp } } : {}) } });
const appConfig = (name: string, backupDb?: string): AppConfig => ({ name, image: "i", ...(backupDb ? { release: { steps: [{ name: "backup", backup: backupDb }] } } : {}) }) as AppConfig;
const facts = (over: Partial<OwnerFacts>): OwnerFacts => ({ ...noFacts(), ...over });

describe("the owner of an app", () => {
  const apps = [app("web", { project: "shop" }), app("blog")];

  it("is its project label, else its own name: an app with no label is its own project", () => {
    expect(ownerOfApp(apps, "web")).toBe("shop");
    expect(ownerOfApp(apps, "blog")).toBe("blog");
  });

  it("is none for an app the server does not list", () => {
    expect(ownerOfApp(apps, "ghost")).toBeNull();
    expect(ownerOfApp([], "web")).toBeNull();
  });

  it("keeps the server pages only of a preview instance, whose variables and source are its parent's", () => {
    expect(hasHubPages(app("web"))).toBe(true);
    expect(hasHubPages(app("web-pr-12"))).toBe(false);
  });
});

describe("the owner of a database", () => {
  it("is its label (status first, then its entry in the configuration), which wins over any app", () => {
    const apps = [app("web", { project: "shop" })];
    expect(ownerOfDatabase(facts({ apps, databases: [db("main", { project: "ledger", app: "web" })] }), "main")).toBe("ledger");
    expect(ownerOfDatabase(facts({ apps, databases: [db("main")], config: { databases: [{ name: "main", project: "ledger" } as never] } }), "main")).toBe("ledger");
  });

  it("is the project of the app it was created for, or of the app whose release step backs it up", () => {
    const apps = [app("web", { project: "shop" }), app("api", { project: "backend" })];
    expect(ownerOfDatabase(facts({ apps, databases: [db("web-db", { app: "web", managed: true })] }), "web-db")).toBe("shop");
    expect(ownerOfDatabase(facts({ apps, databases: [db("ledger")], config: { apps: [appConfig("api", "ledger")] } }), "ledger")).toBe("backend");
  });

  it("is none for a database nothing claims or that the server does not list", () => {
    expect(ownerOfDatabase(facts({ apps: [app("web")], databases: [db("legacy")] }), "legacy")).toBeNull();
    expect(ownerOfDatabase(facts({ apps: [app("web")] }), "legacy")).toBeNull();
  });
});

describe("the owner of a job", () => {
  const apps = [app("web", { project: "shop" }), app("other")];

  it("is its label first", () => {
    expect(ownerOfJob(facts({ apps, jobs: [containerJob("migrate", "web")].map((j) => ({ ...j, project: "ops" })) }), "migrate")).toBe("ops");
    expect(ownerOfJob(facts({ apps, jobs: [job("clean")], config: { jobs: [{ ...httpConfig("clean"), project: "ops" }] } }), "clean")).toBe("ops");
  });

  it("is the project of the app a container job acts on, or an HTTP job authenticates as", () => {
    const f = facts({ apps, jobs: [containerJob("migrate", "web"), httpJob("purge"), httpJob("ping")], config: { jobs: [httpConfig("purge", "web"), httpConfig("ping")] } });
    expect(ownerOfJob(f, "migrate")).toBe("shop");
    expect(ownerOfJob(f, "purge")).toBe("shop");
    expect(ownerOfJob(f, "ping")).toBeNull();
  });

  it("follows its database for a backup job", () => {
    const f = facts({ apps, jobs: [backupJob("web-db"), backupJob("legacy")], databases: [db("web-db", { app: "web" }), db("legacy")] });
    expect(ownerOfJob(f, "backup-web-db")).toBe("shop");
    expect(ownerOfJob(f, "backup-legacy")).toBeNull();
  });

  it("is none for a plain host job and for an unknown job", () => {
    expect(ownerOfJob(facts({ apps, jobs: [job("host-clean")] }), "host-clean")).toBeNull();
    expect(ownerOfJob(facts({ apps }), "nope")).toBeNull();
  });
});

describe("the owner of a container", () => {
  const f = facts({ apps: [app("web", { project: "shop" })], databases: [db("web-db", { app: "web", host: "keelson-db-web" })] });

  it("is the project of the app named by its label, and of the database it hosts", () => {
    expect(ownerOfContainer(f, { name: "web-1", appLabel: "web" })).toBe("shop");
    expect(ownerOfContainer(f, { name: "keelson-db-web" })).toBe("shop");
  });

  it("is none for a container nothing claims", () => {
    expect(ownerOfContainer(f, { name: "redis" })).toBeNull();
  });
});

describe("agreement with the hub's membership", () => {
  // The shell's owner of a job or database must be the project whose tab lists it: the same rules, asked for one entity.
  const apps = [app("web", { project: "shop" }), app("other", { project: "blog" })];
  const model: ConfigModel = { apps: [appConfig("web", "web-db"), appConfig("other")], jobs: [httpConfig("purge", "web"), httpConfig("ping-other", "other")] };
  const jobs = [httpJob("purge"), httpJob("ping-other"), backupJob("web-db"), containerJob("migrate", "other"), job("host-clean"), backupJob("legacy")];
  const databases = [db("web-db", { backup: { job: "backup-web-db" } as never }), db("legacy")];
  const f = facts({ apps, jobs, databases, config: model });

  it.each(["shop", "blog"])("lists in %s exactly the jobs and databases the owner rules give it", (name) => {
    const project = groupProjects(apps.map((a) => ({ server: { id: "s1", name: "s1", canDeploy: true }, app: a, jobs: [] }))).find((p) => p.name === name)!;
    const members = projectMembers(project, [{ server: { id: "s1", name: "s1", canDeploy: true }, apps, jobs, databases, config: model }]);
    expect(members.jobs.map((j) => j.job.name).sort()).toEqual(jobs.map((j) => j.name).filter((n) => ownerOfJob(f, n) === name).sort());
    expect(members.databases.map((d) => d.db.name).sort()).toEqual(databases.map((d) => d.name).filter((n) => ownerOfDatabase(f, n) === name).sort());
  });
});
