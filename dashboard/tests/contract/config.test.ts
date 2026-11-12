import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppStatus, ConfigDocument, ConfigModel, ConfigValidation, DatabaseStatus, JobStatus, ProjectConfigDocument } from "@/lib/agent-types";
import { DeprecationsNotice } from "@/components/config/DeprecationsNotice";
import { appFromDraft, draftFromApp } from "@/components/config/AppForm";
import { draftFromJob, jobFromDraft } from "@/components/config/JobForm";
import { draftFromNotifications, notificationsFromDraft } from "@/components/config/NotificationsForm";
import { databaseFromDraft, draftFromDatabase } from "@/lib/database-config";
import { projectDeprecations } from "@/lib/deprecations-core";
import { derivedProject } from "@/lib/project-config-core";
import { withProject } from "@/lib/project-hub-jobs-core";
import { golden } from "./golden";

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {}, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

// The configuration a real agent answered to GET /v1/config, GET /v1/projects/blog/config and POST /v1/config/validate
// (contract/input holds the files it ran). The forms of the dashboard read this model and write it back: what they read
// must be what is there, and what they write must be what they read.

const config = golden<ConfigDocument>("config");
const project = golden<ProjectConfigDocument>("project-blog-config");
const validation = golden<ConfigValidation>("config-validate");
const rejected = golden<ConfigValidation>("config-validate-invalid");

/** The models there are, named by where they come from. */
const models: { where: string; model: ConfigModel }[] = [
  { where: "GET /v1/config", model: config.model },
  { where: "GET /v1/projects/blog/config", model: project.model },
];

describe("the configuration the real agent answered", () => {
  it("is the one of contract/input: both files, the project file's entries merged into the model", () => {
    expect(config.files?.map((f) => f.path)).toEqual(["apps.yaml", "projects.d/blog.yaml"]);
    expect(config.model.apps?.map((a) => a.name)).toEqual(["shop", "worker", "legacy", "tools", "web", "api", "docs", "site", "blog"]);
    expect(config.model.jobs?.map((j) => j.name)).toEqual(["purge", "warm-cache", "ping", "blog-reindex", "blog-prune"]);
    expect(config.model.databases?.map((d) => d.name)).toEqual(["ledger", "native"]);
    expect(project.project).toBe("blog");
    expect(project.model.apps?.map((a) => a.name)).toEqual(["blog"]);
    expect(config.error).toBeUndefined();
  });

  it("speaks the v1 spelling: no key of the legacy schema is in a model", () => {
    const legacy = ["ports", "host_ports", "port_env", "backup"];
    const apps = models.flatMap((m) => m.model.apps ?? []);
    expect(apps.length).toBeGreaterThan(8);
    for (const app of apps) for (const key of legacy) expect(app, key).not.toHaveProperty(key);
    for (const { model, where } of models) {
      expect(model, where).not.toHaveProperty("postgres");
      expect(model, where).not.toHaveProperty("previews");
    }
    const steps = apps.flatMap((a) => a.release?.steps ?? []);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(Object.keys(step)).not.toContain("run");
    for (const job of models.flatMap((m) => m.model.jobs ?? [])) expect(job).not.toHaveProperty("run");
    for (const database of config.model.databases ?? []) expect(database).not.toHaveProperty("backup");
  });
});

describe("round trip: what the forms read from the real model is what they write back", () => {
  const apps = models.flatMap(({ where, model }) => (model.apps ?? []).map((app) => ({ where, app })));
  const jobs = models.flatMap(({ where, model }) => (model.jobs ?? []).map((job) => ({ where, job })));
  const databases = models.flatMap(({ where, model }) => (model.databases ?? []).map((database) => ({ where, database })));

  it("covers what the dashboard edits", () => {
    expect(apps.length).toBeGreaterThanOrEqual(9);
    expect(jobs.length).toBeGreaterThanOrEqual(5);
    expect(databases.length).toBeGreaterThanOrEqual(2);
    const has = (pick: (a: (typeof apps)[number]["app"]) => unknown) => apps.some(({ app }) => pick(app) !== undefined);
    expect(has((a) => a.publish)).toBe(true);
    expect(has((a) => (typeof a.port === "object" ? a.port : undefined))).toBe(true);
    expect(has((a) => (typeof a.port === "number" ? a.port : undefined))).toBe(true);
    expect(has((a) => a.stop_timeout)).toBe(true);
    expect(has((a) => a.previews)).toBe(true);
    expect(has((a) => a.database)).toBe(true);
    expect(has((a) => a.database?.backups)).toBe(true);
    expect(has((a) => a.release?.steps.find((s) => s.container))).toBe(true);
    expect(has((a) => a.release?.steps.find((s) => s.host))).toBe(true);
    expect(has((a) => a.release?.steps.find((s) => s.backup))).toBe(true);
    expect(has((a) => a.build)).toBe(true);
    expect(has((a) => a.build?.preset)).toBe(true);
    expect(has((a) => a.source)).toBe(true);
    expect(has((a) => a.deploy)).toBe(true);
    expect(jobs.some(({ job }) => job.host)).toBe(true);
    expect(jobs.some(({ job }) => job.container)).toBe(true);
    expect(jobs.some(({ job }) => job.http)).toBe(true);
    expect(databases.some(({ database }) => database.backups)).toBe(true);
    expect(databases.some(({ database }) => database.backups === undefined)).toBe(true);
    expect(databases.some(({ database }) => database.backups?.destinations.some((d) => d.s3))).toBe(true);
    expect(databases.some(({ database }) => database.backups?.destinations.some((d) => d.local))).toBe(true);
  });

  it.each(apps.map((a) => [`${a.where}: ${a.app.name}`, a.app] as const))("the app form writes %s back as it read it", (_name, app) => {
    // A build context of "." is the context a build has without one: the form leaves it out.
    const expected = app.build?.context === "." ? { ...app, build: { ...app.build, context: undefined } } : app;
    expect(appFromDraft(draftFromApp(app))).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it.each(jobs.map((j) => [`${j.where}: ${j.job.name}`, j.job] as const))("the job form writes %s back as it read it", (_name, job) => {
    // The form puts the project of the job back (the page knows it), and a request without a method is a GET: the form shows it and writes it.
    const written = withProject(jobFromDraft(draftFromJob(job)), job.project);
    const expected = job.http && job.http.method === undefined ? { ...job, http: { ...job.http, method: "GET" } } : job;
    expect(written).toEqual(expected);
  });

  it.each(databases.map((d) => [`${d.where}: ${d.database.name}`, d.database] as const))("the database form writes %s back as it read it", (_name, database) => {
    expect(databaseFromDraft(draftFromDatabase(database))).toEqual(database);
  });

  it.each(models.flatMap(({ where, model }) => (model.notifications ? [[where, model.notifications] as const] : [])))("the notifications form writes %s back as it read it", (_where, notifications) => {
    // The form lists the events in its own order, which means nothing to the agent.
    const written = notificationsFromDraft(draftFromNotifications(notifications));
    expect({ ...written, events: written.events && [...written.events].sort() }).toEqual({ ...notifications, events: notifications.events && [...notifications.events].sort() });
  });
});

describe("the deprecations the real agent reported", () => {
  const issues = config.deprecations;

  it("are warnings with a path, the file they are in and the project of a project file's", () => {
    expect(issues.map((d) => [d.path, d.file, d.project])).toEqual([
      ["apps[shop].release.steps[warm].run", "apps.yaml", undefined],
      ["jobs[blog-prune].run", "projects.d/blog.yaml", "blog"],
      ["apps[blog].previews", "projects.d/blog.yaml", "blog"],
    ]);
    for (const d of issues) {
      expect(d.severity).toBe("warning");
      expect(d.code).toBe("deprecated");
      expect(d.message).toMatch(/deprecated/);
      expect(d.line).toBeGreaterThan(0);
    }
  });

  it("are what the validation of the same file says too, and a file with them is valid", () => {
    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual(issues);
  });

  it("leave the model in the new spelling: the forms read it", () => {
    const shop = config.model.apps?.find((a) => a.name === "shop");
    expect(shop?.release?.steps.find((s) => s.name === "warm")).toMatchObject({ host: ["/srv/warm.sh"] });
    expect(project.model.jobs?.find((j) => j.name === "blog-prune")).toMatchObject({ host: ["/srv/prune.sh"] });
    expect(project.model.apps?.[0].previews?.domain).toBe("pr-{pr}-blog.example.com");
    expect(appFromDraft(draftFromApp(shop))).toEqual(shop);
  });

  it("show how many there are, where, and how to migrate them", () => {
    const html = renderToStaticMarkup(createElement(DeprecationsNotice, { issues }));
    expect(html).toContain(`This file uses spellings that are deprecated: ${issues.length}`);
    expect(html).toContain("apps[shop].release.steps[warm].run");
    expect(html).toContain("keelson-agent config migrate --apps /etc/keelson/config/apps.yaml --dry-run");
    expect(html).toContain("sudo -u keelson");
    expect(renderToStaticMarkup(createElement(DeprecationsNotice, { issues: [] }))).toBe("");
  });

  it("are narrowed to a project: its own file's, and in the apps file those of its apps", () => {
    const server = { id: "s1", name: "contract", canDeploy: true };
    const facts = { server, apps: golden<AppStatus[]>("apps"), jobs: golden<JobStatus[]>("jobs"), databases: golden<DatabaseStatus[]>("databases"), config: config.model };
    const members = { jobs: [], databases: [], unassignedJobs: [], unassignedDatabases: [] };
    const shop = projectDeprecations(issues, "shop", derivedProject("shop", server, facts, members));
    expect(shop.map((d) => d.path)).toEqual(["apps[shop].release.steps[warm].run"]);
    const blog = projectDeprecations(issues, "blog", derivedProject("blog", server, facts, members));
    expect(blog.map((d) => d.path)).toEqual(["jobs[blog-prune].run", "apps[blog].previews"]);
    expect(projectDeprecations(issues, "web", derivedProject("web", server, facts, members))).toEqual([]);
  });
});

describe("the validation the real agent answered to a file with a key it does not know", () => {
  it("refuses it with an error that names the file, the line and the path the editor shows", () => {
    expect(rejected.ok).toBe(false);
    const [error] = rejected.issues.filter((i) => i.severity === "error");
    expect(error).toMatchObject({ severity: "error", path: "yaml", file: "apps.yaml" });
    expect(error.line).toBeGreaterThan(0);
    expect(error.message).toMatch(/colour/);
  });

  it("still reports the deprecations of the files", () => {
    expect(rejected.issues.filter((i) => i.severity === "warning")).toEqual(config.deprecations);
  });
});
