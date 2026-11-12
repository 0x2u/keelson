import { describe, expect, it } from "vitest";
import type { AuditEntry as AgentAuditEntry, Deployment, JobRun } from "@/lib/agent-types";
import {
  MAX_ROWS,
  PAGE_SIZE,
  buildFeed,
  filterHref,
  parseFilter,
  type ActivityFilter,
  type ServerActivity,
} from "@/lib/activity-core";
import type { AuditEntry as DashboardAuditEntry } from "@/lib/auth/store";
import { triggerLabel } from "@/lib/labels-core";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const FILTER: ActivityFilter = { failed: false, window: "7d", limit: PAGE_SIZE };

const dep = (id: string, app: string, minutes: number, over: Partial<Deployment> = {}): Deployment => ({
  id,
  app,
  ref: `ghcr.io/me/${app}:v${id}`,
  status: "succeeded",
  trigger: "api",
  started_at: ago(minutes),
  finished_at: ago(minutes - 1),
  ...over,
});
const run = (id: string, minutes: number, over: Partial<JobRun> = {}): JobRun => ({ id, job: "nightly", trigger: "schedule", status: "succeeded", started_at: ago(minutes), ...over });
const audit = (id: number, minutes: number, over: Partial<AgentAuditEntry> = {}): AgentAuditEntry => ({
  id,
  at: ago(minutes),
  method: "POST",
  path: "/v1/apps/web/deploy",
  action: "deploy",
  status: 200,
  detail: "web",
  actor: "dashboard",
  ...over,
});
const dash = (id: number, minutes: number, event: string, detail: string | null = null, over: Partial<DashboardAuditEntry> = {}): DashboardAuditEntry => ({
  id,
  at: NOW - minutes * 60_000,
  event,
  detail,
  ip: "local",
  actor: null,
  ...over,
});

function server(id: string, over: Partial<ServerActivity> = {}): ServerActivity {
  return { server: { id, name: `srv-${id}` }, deployments: [], runs: [], audit: [], versions: [], projects: {}, gaps: [], ...over };
}
const feed = (servers: ServerActivity[], over: { filter?: Partial<ActivityFilter>; dashboard?: DashboardAuditEntry[] } = {}) =>
  buildFeed({ servers, dashboard: over.dashboard ?? [], now: NOW, filter: { ...FILTER, ...over.filter }, trigger: triggerLabel });

describe("buildFeed: merging", () => {
  it("merges every server's deployments, runs and audit entries, newest first", () => {
    const a = server("a", { deployments: [dep("1", "web", 30), dep("2", "web", 5)], runs: [{ run: run("r1", 10), job: "nightly" }] });
    const b = server("b", { deployments: [dep("3", "api", 20)], audit: [audit(9, 1, { action: "app.save", path: "/v1/config/apps/api", detail: "hash abcdef123456" })] });
    const out = feed([a, b], { dashboard: [dash(1, 15, "login", "password")] });
    expect(out.events.map((e) => e.id)).toEqual(["b:a:9", "a:d:2", "a:r:nightly:r1", "dash:1", "b:d:3", "a:d:1"]);
    expect(out.total).toBe(6);
  });

  it("describes a deployment with its status, the app, the version chip's reference and what started it", () => {
    const out = feed([server("a", { deployments: [dep("1", "web", 5, { status: "failed", error: "health check failed\nsecond line", trigger: "webhook" })] })]);
    expect(out.events[0]).toMatchObject({
      kind: "deployment",
      status: "Failed",
      tone: "danger",
      failed: true,
      summary: "Deploy of web failed",
      ref: "ghcr.io/me/web:v1",
      note: "health check failed",
      trigger: "GitHub webhook",
      app: "web",
      href: "/servers/a/deployments/1",
      subject: { label: "web", href: "/servers/a/apps/web" },
    });
  });

  it("tells a rollback, a rolled-back deploy and a running deploy apart in words", () => {
    const out = feed([
      server("a", {
        deployments: [
          dep("1", "web", 1, { status: "running", finished_at: undefined }),
          dep("2", "web", 2, { trigger: "rollback" }),
          dep("3", "web", 3, { status: "rolled_back" }),
          dep("4", "web", 4, { status: "rollback_failed", trigger: "rollback" }),
        ],
      }),
    ]);
    expect(out.events.map((e) => e.summary)).toEqual(["Deploying web", "Rolled back web", "Deploy of web was rolled back", "Rollback of web failed"]);
    expect(out.events[0]).toMatchObject({ live: true, failed: false });
    expect(out.events[1]).toMatchObject({ status: "Rolled back to v2", tone: "success" });
    expect(out.events[2]).toMatchObject({ status: "Deploy rolled back", failed: true, tone: "warning" });
  });

  it("lists job runs with their error line and a link to the run; a run with output gets an output link", () => {
    const out = feed([
      server("a", {
        runs: [
          { run: run("r1", 5, { status: "failed", detail: "HTTP 500\nbody", output: "boom" }), job: "ping" },
          { run: run("r2", 6), job: "ping" },
        ],
      }),
    ]);
    expect(out.events[0]).toMatchObject({
      kind: "job",
      summary: "Job ping failed",
      note: "HTTP 500",
      failed: true,
      href: "/servers/a/jobs/ping?run=r1#run-r1",
      outputHref: "/servers/a/jobs/ping?run=r1#run-r1",
    });
    expect(out.events[1].outputHref).toBeUndefined();
    expect(out.events[1]).toMatchObject({ summary: "Job ping succeeded", failed: false });
  });

  it("lists database backups and restores as backups, linked to the database page", () => {
    const out = feed([
      server("a", {
        runs: [
          { run: run("b1", 5, { job: "backup-kv-pg" }), job: "backup-kv-pg", database: { name: "kv-pg", what: "backup" } },
          { run: run("x1", 4, { job: "restore-kv-pg", status: "failed", detail: "pg_restore: error" }), job: "restore-kv-pg", database: { name: "kv-pg", what: "restore" } },
        ],
      }),
    ]);
    expect(out.events.map((e) => [e.kind, e.summary, e.href])).toEqual([
      ["backup", "Restore of kv-pg failed", "/servers/a/databases/kv-pg?run=x1#run-x1"],
      ["backup", "Backup of kv-pg succeeded", "/servers/a/databases/kv-pg?run=b1#run-b1"],
    ]);
    expect(feed([server("a", { runs: [{ run: run("b1", 5), job: "backup-kv-pg", database: { name: "kv-pg", what: "backup" } }] })], { filter: { kind: "job" } }).events).toHaveLength(0);
  });
});

describe("buildFeed: the agent's audit entries", () => {
  it("names who started a deployment, and does not list the accepted request twice", () => {
    const out = feed([server("a", { deployments: [dep("1", "web", 10)], audit: [audit(1, 10, { actor: "token:ci" })] })]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ id: "a:d:1", actor: "token:ci" });
  });

  it("matches the audit entry written just after the deployment to that deployment, by app and time", () => {
    const out = feed([
      server("a", {
        deployments: [dep("1", "web", 30), dep("2", "api", 10), dep("3", "web", 10)],
        audit: [audit(1, 10 - 0.01, { actor: "token:ci" }), audit(2, 30, { actor: "dashboard" })],
      }),
    ]);
    const byId = Object.fromEntries(out.events.map((e) => [e.id, e.actor]));
    expect(byId).toEqual({ "a:d:1": "dashboard", "a:d:2": undefined, "a:d:3": "token:ci" });
  });

  it("keeps a refused request as a row of its own, with why it matters", () => {
    const out = feed([server("a", { deployments: [dep("1", "web", 10)], audit: [audit(1, 10, { status: 409, actor: "token:ci" })] })]);
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toMatchObject({ kind: "deployment", summary: "Could not deploy web", status: "Not applied", tone: "warning", failed: true, actor: "token:ci" });
  });

  it("keeps an accepted request whose deployment was not fetched", () => {
    const out = feed([server("a", { audit: [audit(1, 10)] })]);
    expect(out.events[0]).toMatchObject({ summary: "Deployed web", kind: "deployment", actor: "dashboard" });
  });

  it("matches job runs and restores to their audit entries", () => {
    const out = feed([
      server("a", {
        runs: [
          { run: run("r1", 5, { trigger: "manual" }), job: "nightly" },
          { run: run("x1", 4, { job: "restore-shop" }), job: "restore-shop", database: { name: "shop", what: "restore" } },
        ],
        audit: [
          audit(1, 5, { action: "job.run", path: "/v1/jobs/nightly/run", detail: "nightly", actor: "token:ops" }),
          audit(2, 4, { action: "database.restore", path: "/v1/databases/shop/restore", detail: "shop backup=x target=shop overwrite=false", actor: "dashboard" }),
        ],
      }),
    ]);
    expect(out.events.map((e) => [e.id, e.actor])).toEqual([
      ["a:r:restore-shop:x1", "dashboard"],
      ["a:r:nightly:r1", "token:ops"],
    ]);
  });

  it("shows configuration changes in words with the app, and files them under config changes", () => {
    const out = feed([server("a", { projects: { web: "shop" }, audit: [audit(1, 5, { action: "app.save", path: "/v1/config/apps/web", detail: "hash 956148ee3463", actor: "token:ci" })] })]);
    expect(out.events[0]).toMatchObject({ kind: "change", summary: "Saved app web", app: "web", project: "shop", actor: "token:ci", subject: { label: "web", href: "/servers/a/apps/web" } });
    expect(out.events[0].note).toBe("apps file changed (version 956148ee3463)");
  });
});

describe("buildFeed: the dashboard's own entries", () => {
  it("lists sign-ins, token changes and integrations in words, with their settings page", () => {
    const out = feed([], {
      dashboard: [
        dash(1, 5, "login", "password"),
        dash(2, 6, "api_token_created", "ci (kv_ab…): deploy, all servers, expires 2027-01-01", { ip: "10.0.0.2" }),
        dash(3, 7, "cloudflare_connected", "2 zone(s)"),
        dash(4, 8, "login_failed", "wrong password"),
      ],
    });
    expect(out.events.map((e) => [e.kind, e.summary, e.href])).toEqual([
      ["security", "Signed in (password)", "/settings/security"],
      ["security", "Created API token ci (kv_ab…): deploy, all servers, expires 2027-01-01", "/settings/api-tokens"],
      ["change", "Connected Cloudflare (2 zone(s))", "/settings/integrations"],
      ["security", "A sign-in failed (wrong password)", "/settings/security"],
    ]);
    expect(out.events[1].note).toBe("from 10.0.0.2");
    expect(out.events[3]).toMatchObject({ failed: true, tone: "danger", status: "Failed" });
  });

  it("leaves out sign-outs, webhook deliveries and the API calls the agent's rows already tell", () => {
    const out = feed([], {
      dashboard: [
        dash(1, 1, "logout"),
        dash(2, 2, "webhook_delivery", "me/web@abc (push): s/web deployed"),
        dash(3, 3, "api_deploy", "server=s app=web ref=v2 outcome=accepted deployment_id=d1", { actor: "token:ci" }),
        dash(4, 4, "api_deploy", "server=s app=web ref=v2 outcome=refused (409): busy", { actor: "token:ci" }),
      ],
    });
    expect(out.events.map((e) => e.id)).toEqual(["dash:4"]);
    expect(out.events[0]).toMatchObject({ kind: "deployment", failed: true, actor: "token:ci", summary: "Could not deploy web: refused (409): busy" });
  });
});

describe("buildFeed: filters", () => {
  const fleet = () => [
    server("a", {
      projects: { web: "shop", api: "shop", blog: "blog" },
      deployments: [dep("1", "web", 30, { status: "failed" }), dep("2", "api", 90), dep("3", "blog", 3 * 24 * 60)],
      runs: [{ run: run("r1", 20, { status: "failed" }), job: "ping" }],
    }),
    server("b", { projects: { web: "shop" }, deployments: [dep("4", "web", 50)] }),
  ];
  const ids = (out: ReturnType<typeof feed>) => out.events.map((e) => e.id);

  it("applies the time window", () => {
    expect(ids(feed(fleet(), { filter: { window: "1h" } }))).toEqual(["a:r:ping:r1", "a:d:1", "b:d:4"]);
    expect(ids(feed(fleet(), { filter: { window: "24h" } }))).toEqual(["a:r:ping:r1", "a:d:1", "b:d:4", "a:d:2"]);
    expect(ids(feed(fleet(), { filter: { window: "7d" } }))).toHaveLength(5);
  });
  it("filters by kind", () => {
    expect(ids(feed(fleet(), { filter: { kind: "job" } }))).toEqual(["a:r:ping:r1"]);
    expect(feed(fleet(), { filter: { kind: "security" } }).events).toEqual([]);
  });
  it("filters by server, which also leaves out the dashboard's own entries", () => {
    const out = feed(fleet(), { filter: { server: "b" }, dashboard: [dash(1, 1, "login")] });
    expect(ids(out)).toEqual(["b:d:4"]);
  });
  it("filters by app and by project", () => {
    expect(ids(feed(fleet(), { filter: { app: "web" } }))).toEqual(["a:d:1", "b:d:4"]);
    expect(ids(feed(fleet(), { filter: { project: "shop", window: "24h" } }))).toEqual(["a:d:1", "b:d:4", "a:d:2"]);
  });
  it("keeps failures only", () => {
    expect(ids(feed(fleet(), { filter: { failed: true } }))).toEqual(["a:r:ping:r1", "a:d:1"]);
  });
  it("combines filters", () => {
    expect(ids(feed(fleet(), { filter: { failed: true, kind: "deployment", server: "a", window: "1h" } }))).toEqual(["a:d:1"]);
  });
  it("offers what exists to filter by, not only what matches", () => {
    const { options } = feed(fleet(), { filter: { kind: "job" } });
    expect(options).toEqual({ servers: [{ id: "a", name: "srv-a" }, { id: "b", name: "srv-b" }], projects: ["blog", "shop"], apps: ["api", "blog", "web"] });
  });
});

describe("buildFeed: servers that did not answer", () => {
  const down = server("b", { unreachable: "cannot reach the agent: connection refused" });

  it("says so, by name and reason, instead of omitting the server", () => {
    const out = feed([server("a", { deployments: [dep("1", "web", 5)] }), down]);
    expect(out.unanswered).toEqual([{ id: "b", name: "srv-b", reason: "cannot reach the agent: connection refused" }]);
    expect(out.events).toHaveLength(1);
  });
  it("still says so when nothing at all could be read, and when the filter is about another server it stays quiet", () => {
    expect(feed([down]).unanswered).toHaveLength(1);
    expect(feed([server("a"), down], { filter: { server: "a" } }).unanswered).toEqual([]);
    expect(feed([server("a"), down], { filter: { server: "b" } }).unanswered).toHaveLength(1);
  });
  it("reports a source that failed on a server that did answer", () => {
    const out = feed([server("a", { gaps: [{ source: "audit log", reason: "timed out" }] })]);
    expect(out.gaps).toEqual([{ server: { id: "a", name: "srv-a" }, source: "audit log", reason: "timed out" }]);
    expect(out.unanswered).toEqual([]);
  });
});

describe("buildFeed: paging and caps", () => {
  const many = (n: number) => server("a", { deployments: Array.from({ length: n }, (_, i) => dep(String(i), "web", i + 1)) });

  it("shows a page and says there is more", () => {
    const out = feed([many(100)]);
    expect(out.events).toHaveLength(PAGE_SIZE);
    expect(out).toMatchObject({ total: 100, more: true, capped: false });
    expect(out.events[0].id).toBe("a:d:0");
  });
  it("grows with the limit, up to the most the page ever shows", () => {
    expect(feed([many(100)], { filter: { limit: 80 } }).events).toHaveLength(80);
    const out = feed([many(300)], { filter: { limit: 10_000 } });
    expect(out.events).toHaveLength(MAX_ROWS);
  });
  it("is not capped when everything fits, and is capped at the most", () => {
    expect(feed([many(10)])).toMatchObject({ more: false, capped: false, total: 10 });
    expect(feed([many(300)], { filter: { limit: MAX_ROWS } })).toMatchObject({ more: false, capped: true, total: 300 });
  });
  it("cuts a long error to one line of bounded length", () => {
    const out = feed([server("a", { deployments: [dep("1", "web", 1, { status: "failed", error: "x".repeat(2000) })] })]);
    expect(out.events[0].note?.length).toBeLessThanOrEqual(220);
    expect(out.events[0].note?.endsWith("…")).toBe(true);
  });
});

describe("parseFilter and filterHref", () => {
  it("reads the filter from the URL and falls back to the default for what it does not know", () => {
    expect(parseFilter({})).toEqual({ kind: undefined, server: undefined, project: undefined, app: undefined, failed: false, window: "7d", limit: PAGE_SIZE });
    expect(parseFilter({ kind: "backup", server: "s1", app: "web", failed: "1", window: "1h", limit: "80" })).toMatchObject({ kind: "backup", server: "s1", app: "web", failed: true, window: "1h", limit: 80 });
    expect(parseFilter({ kind: "nope", window: "3y", limit: "-4", failed: "yes" })).toMatchObject({ kind: undefined, window: "7d", limit: PAGE_SIZE, failed: false });
    expect(parseFilter({ limit: "99999" }).limit).toBe(MAX_ROWS);
    expect(parseFilter({ kind: ["job", "backup"] }).kind).toBe("job");
  });
  it("builds the URL, leaving defaults out and starting again at the first page when a filter changes", () => {
    const f = parseFilter({ failed: "1", window: "24h", limit: "80" });
    expect(filterHref({ ...f, limit: PAGE_SIZE })).toBe("/activity?failed=1&window=24h");
    expect(filterHref(f, { kind: "job" })).toBe("/activity?kind=job&failed=1&window=24h");
    expect(filterHref(f, { limit: 120 })).toBe("/activity?failed=1&window=24h&limit=120");
    expect(filterHref(f, { failed: false, window: "7d" })).toBe("/activity");
    expect(parseFilter(Object.fromEntries(new URL(`http://x${filterHref(f, { server: "a b", app: "web" })}`).searchParams))).toMatchObject({ server: "a b", app: "web", failed: true });
  });
});
