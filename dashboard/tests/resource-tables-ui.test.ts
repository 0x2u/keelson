import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseStatus, JobStatus } from "@/lib/agent-types";
import type { HubDatabase, HubJob } from "@/lib/project-hub-core";
import type { DatabaseEntry, JobEntry } from "@/lib/resource-lists-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {}, replace() {} }) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { JobsTable } = await import("@/components/jobs/JobsTable");
const { DatabasesTable } = await import("@/components/databases/DatabasesTable");

const NOW = Date.parse("2026-10-31T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const s1 = { id: "s1", name: "vps-1", canDeploy: true };
const s2 = { id: "s2", name: "edge", canDeploy: false };

const html = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const states = (out: string) => [...out.matchAll(/data-slot="resource-row" data-state="([a-z-]+)"/g)].map((m) => m[1]);
const rowNames = (out: string) => [...out.matchAll(/data-slot="resource-row"[^>]*><td[^>]*><div[^>]*><a [^>]*>([^<]+)</g)].map((m) => m[1]);
const hrefs = (out: string) => [...out.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

const job = (name: string, over: Partial<JobStatus> = {}): JobStatus => ({
  name,
  schedule: "0 6 * * *",
  timezone: "UTC",
  kind: "http",
  target: "GET http://app/report",
  paused: false,
  running: false,
  next_run: new Date(NOW + HOUR).toISOString(),
  last_run: { id: "r1", job: name, trigger: "schedule", status: "succeeded", started_at: ago(HOUR) },
  ...over,
});
const failedRun = (name: string, detail = "HTTP 500 from the app") => ({ id: "r2", job: name, trigger: "schedule" as const, status: "failed" as const, started_at: ago(1000), detail });
const jobEntry = (name: string, over: Partial<JobStatus> = {}, server = s1, extra: Partial<JobEntry> = {}): JobEntry => ({ server, job: job(name, over), ...extra });
const jobProps = { unanswered: [], servers: [s1], from: "/jobs", now: NOW };

describe("JobsTable", () => {
  describe("empty", () => {
    it("fleet: explains what a job is and offers Add job to the one server, returning to the list", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [] }));
      expect(out).toContain('data-slot="empty-state"');
      expect(hrefs(out)).toContain(`/servers/s1/config/jobs/new?from=${encodeURIComponent("/jobs")}`);
      expect(out).not.toContain("resource-table");
    });
    it("fleet without any server: asks for a server first", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [], servers: [] }));
      expect(hrefs(out)).toContain("/servers/new");
      expect(out).not.toContain("/config/jobs/new");
    });
    it("project and server: say whose jobs they are; a project's names its apps and databases", () => {
      const project = html(createElement(JobsTable, { ...jobProps, scope: "project", entries: [], from: "/projects/shop/jobs" }));
      expect(project).toContain('data-slot="empty-state"');
      expect(project).toContain("backups of their databases");
      expect(hrefs(project)).toContain(`/servers/s1/config/jobs/new?from=${encodeURIComponent("/projects/shop/jobs")}`);
      expect(html(createElement(JobsTable, { ...jobProps, scope: "server", entries: [] }))).toContain("No jobs on this server");
    });
    it("two servers: Add job asks on which server", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [], servers: [s1, s2] }));
      expect(out).toContain('aria-haspopup="menu"');
      expect(out).toContain("Add job");
      expect(hrefs(out).filter((h) => h.includes("/config/jobs/new"))).toEqual([]);
    });
  });

  describe("rows", () => {
    const entries = [
      jobEntry("fine"),
      jobEntry("paused-one", { paused: true, next_run: undefined }),
      jobEntry("never", { last_run: undefined }),
      jobEntry("broken", { last_run: failedRun("broken") }),
      jobEntry("busy", { running: true }),
    ];
    const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries }));

    it("puts the failing job first, then the one never run, then the paused one, then the running one, then the fine one", () => {
      expect(rowNames(out)).toEqual(["broken", "never", "paused-one", "busy", "fine"]);
      expect(states(out)).toEqual(["failed", "never-run", "paused", "running", "ok"]);
    });

    it("says why the failing one failed, and says Never run, Paused and Running now in the shared words", () => {
      expect(out).toContain("HTTP 500 from the app");
      expect(out).toContain("Never run");
      expect(out).toContain("Paused");
      expect(out).toContain("Running now");
      // "never" is scheduled for an hour from now and has not reached its first run yet: it is new, not a problem.
      expect(out).toContain("1 need a look");
      expect(out).toContain("5 jobs");
    });

    it("counts a job that never ran as needing a look once its first run is late, or when nothing is scheduled", () => {
      const late = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [jobEntry("late", { last_run: undefined, next_run: new Date(NOW - HOUR).toISOString() })] }));
      expect(late).toContain("1 need a look");
      const unscheduled = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [jobEntry("none", { last_run: undefined, next_run: undefined })] }));
      expect(unscheduled).toContain("1 need a look");
      const fresh = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [jobEntry("fresh", { last_run: undefined })] }));
      expect(fresh).toContain("0 need a look");
      expect(fresh).toContain("Never run");
    });

    it("links each job to its history and offers Edit and Run now, gated by the server", () => {
      expect(hrefs(out)).toContain("/servers/s1/jobs/broken");
      expect(hrefs(out)).toContain(`/servers/s1/config/jobs/broken?from=${encodeURIComponent("/jobs")}`);
      expect(out).toContain('aria-label="Run now: broken"');
      expect(out).toContain('data-gate="allowed"');
    });

    it("disables Run now of a job that is running", () => {
      const button = (out.match(/<button[^>]*>/g) ?? []).find((b) => b.includes('aria-label="Run now: busy"'));
      expect(button).toMatch(/disabled/);
    });

    it("has a sticky head and stacked cards under 640 px: each cell carries its column's name", () => {
      expect(out).toContain('data-slot="resource-table"');
      expect(out).toContain("sticky top-14");
      expect(out).toContain('data-label="Last run"');
      expect(out).toContain('data-label="Next run"');
      expect(out).toContain("max-sm:flex");
    });
  });

  describe("scopes", () => {
    const shop: HubJob = { server: s1, job: job("purge"), via: "http-bearer", app: "shop" };
    const entries = [jobEntry("purge", {}, s1, { project: "shop", hub: shop }), jobEntry("tick", {}, s2)];

    it("fleet: shows the project and the server of each job, linking to the project and to that server's list", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries, servers: [s1, s2] }));
      expect(out).toContain('data-scope="fleet"');
      expect(out).toContain('data-label="Project"');
      expect(out).toContain('data-label="Server"');
      expect(hrefs(out)).toContain("/projects/shop");
      expect(hrefs(out)).toContain("/jobs?server=s1");
      expect(hrefs(out)).toContain("/jobs?server=s2");
      expect(out).not.toContain("Authenticates as app");
    });
    it("project: hides the project, says why each job belongs, and lists what no app claims, collapsed", () => {
      const out = html(
        createElement(JobsTable, {
          ...jobProps,
          scope: "project",
          entries: [entries[0]],
          from: "/projects/shop/jobs",
          unassigned: [{ server: s1, job: job("host-clean", { kind: "host" }) }],
        }),
      );
      expect(out).not.toContain('data-label="Project"');
      expect(out).toContain('data-label="Server"');
      expect(out).toContain("Authenticates as app shop");
      expect(out).toContain("<details");
      expect(out).not.toContain("<details open");
      expect(out).toContain("Not assigned to a project on this server (1)");
      expect(hrefs(out)).toContain("/jobs?server=s1");
      expect(hrefs(out)).toContain(`/servers/s1/config/jobs/purge?from=${encodeURIComponent("/projects/shop/jobs")}`);
    });
    it("server: hides the server column and keeps the project", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "server", entries: [entries[0]], from: "/jobs?server=s1" }));
      expect(out).toContain('data-scope="server"');
      expect(out).not.toContain('data-label="Server"');
      expect(out).toContain('data-label="Project"');
      expect(hrefs(out)).toContain(`/servers/s1/config/jobs/purge?from=${encodeURIComponent("/jobs?server=s1")}`);
    });
  });

  describe("servers", () => {
    it("two servers: Add job asks which; every job names its server", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", servers: [s1, s2], entries: [jobEntry("a"), jobEntry("b", {}, s2)] }));
      expect(out).toContain('aria-haspopup="menu"');
      expect(out).toContain("vps-1");
      expect(out).toContain("edge");
    });
    it("a read-only server: Run now and Edit are disabled with the reason, and no configuration link is offered", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", servers: [s2], entries: [jobEntry("b", {}, s2)] }));
      expect(out.match(/data-gate="read-only"/g)?.length).toBeGreaterThanOrEqual(2);
      expect(out).toContain("disabled");
      expect(hrefs(out).filter((h) => h.includes("/config/jobs/"))).toEqual([]);
    });
    it("an unreachable server is named above the rows of the ones that answered", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [jobEntry("a")], unanswered: [{ id: "s9", name: "far", reason: "timeout" }] }));
      expect(out).toContain("Can&#x27;t tell: far did not answer (timeout)");
      expect(out).toContain("resource-table");
    });
    it("only unreachable servers: says it can't tell instead of claiming there are no jobs", () => {
      const out = html(createElement(JobsTable, { ...jobProps, scope: "fleet", entries: [], unanswered: [{ id: "s9", name: "far", reason: "timeout" }] }));
      expect(out).toContain("Can&#x27;t tell: far did not answer");
      expect(out).not.toContain('data-slot="empty-state"');
    });
  });
});

const db = (name: string, over: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "pg",
  port: 5432,
  database: name,
  user: "u",
  version: 16,
  network: "n",
  has_password: true,
  backup: {
    schedule: "0 3 * * *",
    timezone: "UTC",
    keep: 7,
    keep_days: 30,
    paused: false,
    destination: "local:/b",
    recipients: 1,
    job: `backup-${name}`,
    next_run: new Date(NOW + HOUR).toISOString(),
    last_run: { id: "b1", status: "succeeded", started_at: ago(HOUR), finished_at: ago(HOUR) },
  },
  ...over,
});
const dbEntry = (name: string, over: Partial<DatabaseStatus> = {}, server = s1, extra: Partial<DatabaseEntry> = {}): DatabaseEntry => ({ server, db: db(name, over), ...extra });
const dbProps = { unanswered: [], servers: [s1], from: "/databases", now: NOW };
const overdue = (name: string) => dbEntry(name, { backup: { ...db(name).backup!, next_run: ago(2 * DAY), last_run: { id: "b", status: "succeeded", started_at: ago(5 * DAY), finished_at: ago(5 * DAY) } } });

describe("DatabasesTable", () => {
  describe("empty", () => {
    it("fleet: explains, and offers Add database to the one server, returning to the list", () => {
      const out = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries: [] }));
      expect(out).toContain('data-slot="empty-state"');
      expect(hrefs(out)).toContain(`/servers/s1/config/databases/new?from=${encodeURIComponent("/databases")}`);
    });
    it("fleet without any server, project and server", () => {
      expect(hrefs(html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries: [], servers: [] })))).toContain("/servers/new");
      const project = html(createElement(DatabasesTable, { ...dbProps, scope: "project", entries: [], from: "/projects/shop/databases" }));
      expect(project).toContain("backed up before their release");
      expect(hrefs(project)).toContain(`/servers/s1/config/databases/new?from=${encodeURIComponent("/projects/shop/databases")}`);
      expect(html(createElement(DatabasesTable, { ...dbProps, scope: "server", entries: [] }))).toContain("No databases on this server");
    });
  });

  describe("rows", () => {
    const failed = dbEntry("failed", { backup: { ...db("failed").backup!, last_run: { id: "f", status: "failed", started_at: ago(HOUR), detail: "pg_dump: connection refused" } } });
    const entries = [dbEntry("fine"), dbEntry("paused", { backup: { ...db("paused").backup!, paused: true } }), overdue("old"), dbEntry("bare", { backup: null }), failed];
    const out = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries }));

    it("puts the problems first: failed, overdue, not backed up, paused, then the fine one", () => {
      expect(rowNames(out)).toEqual(["failed", "old", "bare", "paused", "fine"]);
      expect(states(out)).toEqual(["failed", "overdue", "not-configured", "paused", "ok"]);
      expect(out).toContain("4 need a look");
      expect(out).toContain("5 databases");
    });

    it("says what is wrong in the shared words, with the retention", () => {
      expect(out).toContain("Last backup failed");
      expect(out).toContain("Overdue");
      expect(out).toContain("No backup configured");
      expect(out).toContain("Backups paused");
      expect(out).toContain("Keeps last 7 and 30 days");
      expect(out).toContain("PostgreSQL 16");
    });

    it("links each database to its page, and offers Edit, Back up now and Restore", () => {
      expect(hrefs(out)).toContain("/servers/s1/databases/old");
      expect(hrefs(out)).toContain(`/servers/s1/config/databases/old?from=${encodeURIComponent("/databases")}`);
      expect(out).toContain("Back up now");
      expect(out).toContain("Restore");
      // Restore without the streamed dialog leads to the database's page, where it lives.
      expect(out).toMatch(/<a [^>]*href="\/servers\/s1\/databases\/fine"[^>]*>Restore<\/a>/);
    });

    it("uses the page's streamed Restore and backup size when it gives them", () => {
      const streamed = html(
        createElement(DatabasesTable, {
          ...dbProps,
          scope: "fleet",
          entries: [overdue("old")],
          restore: (_s: string, name: string) => createElement("span", { "data-restore": name }, "restore-dialog"),
          backupSize: (s: string, d: string) => createElement("span", { "data-size": `${s}/${d}` }, "12.0 MB"),
        }),
      );
      expect(streamed).toContain('data-restore="old"');
      expect(streamed).toContain('data-size="s1/old"');
    });
  });

  describe("scopes", () => {
    const hub: HubDatabase = { server: s1, db: db("md"), via: "managed-app", apps: ["shop"] };
    const entries = [dbEntry("md", {}, s1, { project: "shop", hub }), dbEntry("other", {}, s2)];

    it("fleet: project and server of each database", () => {
      const out = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries, servers: [s1, s2] }));
      expect(out).toContain('data-label="Project"');
      expect(out).toContain('data-label="Server"');
      expect(hrefs(out)).toContain("/projects/shop");
      expect(hrefs(out)).toContain("/databases?server=s2");
      expect(out).not.toContain("Managed by app");
    });
    it("project: says why each belongs and collapses what no app claims", () => {
      const out = html(
        createElement(DatabasesTable, {
          ...dbProps,
          scope: "project",
          entries: [entries[0]],
          from: "/projects/shop/databases",
          unassigned: [{ server: s1, db: db("legacy") }],
        }),
      );
      expect(out).not.toContain('data-label="Project"');
      expect(out).toContain("Managed by app shop");
      expect(out).toContain("<details");
      expect(out).toContain("Not assigned to a project on this server (1)");
      expect(hrefs(out)).toContain("/databases?server=s1");
    });
    it("server: no server column", () => {
      const out = html(createElement(DatabasesTable, { ...dbProps, scope: "server", entries: [entries[0]], from: "/databases?server=s1" }));
      expect(out).not.toContain('data-label="Server"');
      expect(out).toContain('data-label="Project"');
    });
  });

  describe("servers", () => {
    it("two servers: Add database asks which", () => {
      const out = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", servers: [s1, s2], entries: [dbEntry("a"), dbEntry("b", {}, s2)] }));
      expect(out).toContain('aria-haspopup="menu"');
    });
    it("a read-only server: Back up now, Restore and Edit are disabled with the reason, and nothing would run", () => {
      const out = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", servers: [s2], entries: [dbEntry("b", {}, s2)], restore: () => createElement("span", null, "restore-dialog") }));
      expect(out.match(/data-gate="read-only"/g)?.length).toBeGreaterThanOrEqual(3);
      expect(out).not.toContain("restore-dialog");
      expect(hrefs(out).filter((h) => h.includes("/config/databases/"))).toEqual([]);
    });
    it("an unreachable server is named above the rows; alone it says it can't tell", () => {
      const far = { id: "s9", name: "far", reason: "connect ECONNREFUSED" };
      const some = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries: [dbEntry("a")], unanswered: [far] }));
      expect(some).toContain("Can&#x27;t tell: far did not answer (connect ECONNREFUSED)");
      expect(some).toContain("resource-table");
      const alone = html(createElement(DatabasesTable, { ...dbProps, scope: "fleet", entries: [], unanswered: [far] }));
      expect(alone).toContain("Can&#x27;t tell: far did not answer");
      expect(alone).not.toContain('data-slot="empty-state"');
    });
  });
});
