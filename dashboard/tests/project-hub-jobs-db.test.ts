import { projectOptions } from "@/lib/database-config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseStatus, JobStatus } from "@/lib/agent-types";
import { hubCrumbs, projectOfReturnPath, safeReturnPath } from "@/lib/nav-core";
import type { HubDatabase, HubJob } from "@/lib/project-hub-core";
import {
  databaseEditHref,
  databaseViaText,
  databaseEntryRows,
  hubTabPath,
  jobEditHref,
  jobRows,
  jobRunsHref,
  jobViaText,
  newDatabaseHref,
  newJobHref,
  retentionText,
  withFrom,
  withProject,
} from "@/lib/project-hub-jobs-core";

vi.mock("@/app/config-actions", () => ({ saveJobAction: vi.fn(), saveDatabaseAction: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { JobForm } = await import("@/components/config/JobForm");
const { DatabaseForm } = await import("@/components/config/DatabaseForm");

const NOW = Date.parse("2026-10-31T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const vps1 = { id: "s1", name: "vps-1", canDeploy: true };

const job = (over: Partial<JobStatus> = {}): JobStatus => ({
  name: "daily-report",
  schedule: "0 6 * * *",
  timezone: "UTC",
  kind: "http",
  target: "GET http://app/report",
  paused: false,
  running: false,
  next_run: new Date(NOW + 3_600_000).toISOString(),
  last_run: { id: "r1", job: "daily-report", trigger: "schedule", status: "succeeded", started_at: ago(3_600_000) },
  ...over,
});
const hubJob = (over: Partial<JobStatus> = {}, server = vps1, extra: Partial<HubJob> = {}): HubJob => ({ server, job: job(over), via: "http-bearer", app: "shop", ...extra });

const db = (over: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  name: "shop",
  engine: "postgres",
  host: "pg",
  port: 5432,
  database: "md",
  user: "md",
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
    job: "backup-shop",
    next_run: new Date(NOW + 3_600_000).toISOString(),
    last_run: { id: "b1", status: "succeeded", started_at: ago(3_600_000), finished_at: ago(3_500_000) },
  },
  ...over,
});
const hubDb = (over: Partial<DatabaseStatus> = {}, server = vps1): HubDatabase => ({ server, db: db(over), via: "managed-app", apps: ["shop"] });

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe("hub links", () => {
  it("carry the tab as ?from= and the guard accepts them", () => {
    const from = hubTabPath("shop", "jobs");
    expect(from).toBe("/projects/shop/jobs");
    for (const href of [newJobHref("s1", from), jobEditHref("s1", job(), from), newDatabaseHref("s1", from), databaseEditHref("s1", "a b", from)]) {
      const q = new URL(href, "http://x").searchParams.get("from");
      expect(safeReturnPath(q ?? undefined)).toBe(from);
    }
  });
  it("edits the database of a backup job", () => {
    expect(jobEditHref("s1", job({ name: "backup-md", kind: "backup" }), "/projects/p/jobs")).toBe(
      `/servers/s1/config/databases/md?from=${encodeURIComponent("/projects/p/jobs")}`,
    );
    expect(withFrom("/a", "/projects/p")).toBe("/a?from=%2Fprojects%2Fp");
    expect(jobRunsHref("s1", "a b")).toBe("/servers/s1/jobs/a%20b");
  });
  it("refuses foreign return paths", () => {
    expect(safeReturnPath("https://evil.example")).toBeNull();
    expect(safeReturnPath("//evil.example")).toBeNull();
  });
});

describe("job rows and database rows", () => {
  it("puts the failing job first and explains why a job belongs", () => {
    const failing = hubJob({ name: "analytics-purge", last_run: { id: "r", job: "x", trigger: "schedule", status: "failed", started_at: ago(1000), detail: "HTTP 500" } });
    const rows = jobRows([hubJob(), failing]);
    expect(rows[0]?.entry.job.name).toBe("analytics-purge");
    expect(rows[0]?.state).toBe("failed");
    expect(jobViaText(hubJob())).toContain("app shop");
  });
  it("says that a label is why a job or a database belongs", () => {
    expect(jobViaText(hubJob({}, vps1, { via: "label" }))).toMatch(/label/i);
    expect(databaseViaText({ ...hubDb(), via: "label" })).toMatch(/label/i);
  });
  it("puts an overdue backup before a fine one", () => {
    const overdue = hubDb({ name: "old", backup: { ...db().backup!, job: "backup-old", next_run: ago(2 * DAY), last_run: { id: "b", status: "succeeded", started_at: ago(5 * DAY), finished_at: ago(5 * DAY) } } });
    const rows = databaseEntryRows([hubDb(), overdue], NOW);
    expect(rows.map((r) => [r.entry.db.name, r.state])).toEqual([
      ["old", "overdue"],
      ["shop", "ok"],
    ]);
    expect(retentionText({ keep: 7, keep_days: 30 })).toBe("Keeps last 7 and 30 days");
  });
});

describe("project of a new entity", () => {
  it("is derived from the return path and breadcrumbs lead back to the hub", () => {
    expect(projectOfReturnPath("/projects/shop/jobs")).toBe("shop");
    expect(projectOfReturnPath("https://evil.example/projects/shop")).toBeNull();
    expect(hubCrumbs("shop", { label: "Jobs", href: "/projects/shop/jobs" }, { label: "New job" }).map((c) => c.label)).toEqual(["Projects", "shop", "Jobs", "New job"]);
  });
  it("is added to the saved config only when there is one", () => {
    expect(withProject({ name: "a" }, "shop")).toEqual({ name: "a", project: "shop" });
    expect(withProject({ name: "a" }, undefined)).toEqual({ name: "a" });
  });
  it("shows the project read-only in the new forms, and the existing one when editing", () => {
    const base = { serverId: "s1", baseHash: "h", existingNames: [] as string[], apps: [] };
    expect(html(createElement(JobForm, { ...base, project: "shop" }))).toContain("Project: <span");
    expect(html(createElement(JobForm, base))).not.toContain("form-project");
    expect(html(createElement(JobForm, { ...base, project: "other", job: { name: "j", schedule: "@daily", host: ["x"], project: "shop" } }))).toContain("shop</span>");
  });
  it("lets the database form choose the project, from the known ones, none included", () => {
    const dbBase = { serverId: "s1", baseHash: "h", existingNames: [] as string[], projects: ["shop", "blog"] };
    const page = html(createElement(DatabaseForm, { ...dbBase, project: "shop" }));
    expect(page).toContain("Project");
    expect(page).toContain("shop");
    expect(html(createElement(DatabaseForm, dbBase))).toContain("The project this database belongs to");
    expect(projectOptions(["shop", "blog"], "old")).toEqual([
      { value: "none", label: "No project" },
      { value: "blog", label: "blog" },
      { value: "old", label: "old" },
      { value: "shop", label: "shop" },
    ]);
  });
});
