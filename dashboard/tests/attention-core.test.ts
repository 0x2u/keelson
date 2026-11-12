import { describe, expect, it } from "vitest";
import type { AppStatus, Container, DatabaseStatus, Deployment, JobStatus, SystemInfo } from "@/lib/agent-types";
import { attentionItems, cantTell, firstLine, itemsOf, spanText, summarize, type ServerSnapshot } from "@/lib/attention-core";
import { imageVersion } from "@/lib/image-ref-core";
import { schedulePeriodMs } from "@/lib/schedule-period";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const GIB = 1024 ** 3;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SERVER = { id: "s1", name: "vps-1" };

const system = (over: Partial<SystemInfo["host"]> = {}): SystemInfo => ({
  time: ago(0),
  host: {
    cpus: 2,
    load: { one: 0.2, five: 0.2, fifteen: 0.2 },
    memory: { total: 4 * GIB, available: 3 * GIB, swap_total: 0, swap_free: 0 },
    disk: { path: "/", total: 100 * GIB, free: 60 * GIB },
    ...over,
  },
});

const deployment = (over: Partial<Deployment> = {}): Deployment => ({
  id: "d1",
  app: "shop",
  ref: "ghcr.io/acme/shop:v2",
  status: "succeeded",
  trigger: "api",
  started_at: ago(10 * MIN),
  finished_at: ago(9 * MIN),
  ...over,
});

const app = (over: Partial<AppStatus> = {}, state: Partial<NonNullable<AppStatus["container"]>["state"]> | null = {}): AppStatus => ({
  name: "shop",
  image: "ghcr.io/acme/shop",
  project: "",
  environment: "",
  digest: "",
  container: state
    ? {
        id: "c1",
        name: "shop-1",
        image: "ghcr.io/acme/shop:v2",
        created: ago(HOUR),
        tty: false,
        restart_count: 0,
        ports: [],
        state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0, started_at: ago(HOUR), ...state },
      }
    : null,
  last_deployment: deployment(),
  ...over,
});

const job = (over: Partial<JobStatus> = {}): JobStatus => ({
  name: "nightly",
  schedule: "0 3 * * *",
  timezone: "UTC",
  kind: "http",
  target: "GET http://x",
  paused: false,
  running: false,
  ...over,
});

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
  backup:
    backup === null
      ? null
      : { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: "backup-main", next_run: ago(-HOUR), last_run: null, ...backup },
});

const snap = (over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({ server: SERVER, reachable: true, lastSeen: NOW, apps: [], jobs: [], databases: [], system: system(), containers: [], proxy: null, ...over });

const items = (over: Partial<ServerSnapshot> = {}, now = NOW) => attentionItems([snap(over)], now);

describe("a healthy fleet", () => {
  it("has nothing that needs attention and the verdict says so", () => {
    const list = items({ apps: [app()], jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "succeeded", started_at: ago(HOUR) } })], databases: [database({ last_run: { id: "b", status: "succeeded", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR) } })] });
    expect(list).toEqual([]);
    expect(summarize(list)).toEqual({ tone: "success", label: "Everything is fine", count: 0 });
  });
});

describe("apps", () => {
  it("flags a stopped app with its exit code, when it stopped, and links to its logs and deployment", () => {
    const [item, ...rest] = items({ apps: [app({}, { running: false, status: "exited", exit_code: 3, finished_at: ago(5 * MIN) })] });
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ severity: "critical", kind: "app-down", subject: "shop", message: "shop is stopped (exit code 3)", since: ago(5 * MIN) });
    expect(item.actions.map((a) => a.label)).toEqual(["Logs", "Deployment"]);
    expect(item.actions[0].href).toBe("/servers/s1/containers/shop-1");
    expect(item.actions[1].href).toBe("/servers/s1/deployments/d1");
  });

  it("names the out-of-memory kill as the cause", () => {
    expect(items({ apps: [app({}, { running: false, oom_killed: true, exit_code: 137, finished_at: ago(MIN) })] })[0].message).toBe("shop is stopped (killed: out of memory)");
  });

  it("flags a restarting app and an unhealthy one", () => {
    expect(items({ apps: [app({}, { restarting: true, running: true, exit_code: 1 })] })[0].message).toBe("shop keeps restarting (exit code 1)");
    expect(items({ apps: [app({}, { health: "unhealthy" })] })[0].message).toBe("shop is unhealthy: its health check fails");
  });

  it("offers a roll back link naming the previous version when the last deployment succeeded", () => {
    const stopped = app({ last_deployment: deployment({ previous_ref: "ghcr.io/acme/shop:v1" }) }, { running: false, exit_code: 0, finished_at: ago(MIN) });
    const labels = items({ apps: [stopped] })[0].actions.map((a) => a.label);
    expect(labels).toContain("Roll back to v1");
  });

  it("flags an app that was never deployed as info, and an app with no container after a success as critical", () => {
    expect(items({ apps: [app({ last_deployment: null }, null)] })[0]).toMatchObject({ severity: "info", message: "shop is configured but has never been deployed" });
    expect(items({ apps: [app({}, null)] })[0]).toMatchObject({ severity: "critical", kind: "app-down" });
  });

  it("flags a failed deployment while it is the latest event for the app, with the error", () => {
    const failed = app({ last_deployment: deployment({ status: "failed", error: "health check failed\nsecond line", finished_at: ago(2 * MIN) }) });
    const [item] = items({ apps: [failed] });
    expect(item).toMatchObject({ severity: "warning", kind: "deployment", message: "Deploy of shop v2 failed: health check failed", since: ago(2 * MIN) });
    expect(item.actions[0].href).toBe("/servers/s1/deployments/d1");
  });

  it("flags a rolled back deployment as a warning and a failed rollback as critical", () => {
    expect(items({ apps: [app({ last_deployment: deployment({ status: "rolled_back", error: "unhealthy" }) })] })[0]).toMatchObject({ severity: "warning", message: "Deploy of shop v2 was rolled back: unhealthy" });
    const notRestored = items({ apps: [app({ last_deployment: deployment({ status: "rollback_failed" }) })] })[0];
    expect(notRestored.severity).toBe("critical");
    expect(notRestored.message).toBe("Deploy of shop v2 failed and the previous version could not be restored");
    expect(items({ apps: [app({ last_deployment: deployment({ status: "rollback_failed", trigger: "rollback" }) })] })[0].message).toBe("Rollback of shop v2 failed");
  });

  it("does not flag a deployment that succeeded after a failed one (the latest event wins)", () => {
    expect(items({ apps: [app({ last_deployment: deployment({ status: "succeeded" }) })] })).toEqual([]);
  });
});

describe("containers", () => {
  const container = (over: Partial<Container>): Container => ({ id: "x", name: "worker", image: "i", image_id: "", command: "", created: 0, state: "running", status: "Up 1 hour", labels: {}, ports: [], ...over });

  it("flags an unhealthy or restarting container, once, and ignores one-off containers that exited", () => {
    const list = items({
      containers: [
        container({ name: "a", status: "Up 1 hour (unhealthy)" }),
        container({ name: "b", state: "restarting", status: "Restarting (1) 3 seconds ago" }),
        container({ name: "migrate", state: "exited", status: "Exited (0)", labels: { "keelson.app": "shop", "keelson.release": "true" } }),
        container({ name: "adhoc", state: "exited", status: "Exited (0)" }),
      ],
    });
    expect(list.map((i) => i.subject).sort()).toEqual(["a", "b"]);
  });

  it("flags a managed container that exited when no configured app covers it, and does not double count an app's container", () => {
    const managed = container({ name: "shop-1", state: "exited", status: "Exited (3)", labels: { "keelson.app": "shop" } });
    const list = items({ containers: [managed], apps: [app({}, { running: false, exit_code: 3, finished_at: ago(MIN) })] });
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("app-down");
    expect(items({ containers: [managed] })[0]).toMatchObject({ kind: "container", message: "Container shop-1 is exited" });
  });
});

describe("jobs", () => {
  it("flags a job whose last run failed, with the error line and a link to its output", () => {
    const failing = job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", detail: "exit status 2\nmore", started_at: ago(HOUR), finished_at: ago(HOUR - MIN) } });
    const [item] = items({ jobs: [failing] });
    expect(item).toMatchObject({ severity: "warning", kind: "job", message: "Job nightly failed: exit status 2", since: ago(HOUR - MIN) });
    expect(item.actions).toEqual([{ label: "Job output", href: "/servers/s1/jobs/nightly" }]);
  });

  it("leaves a database's backup job to the database rule", () => {
    const backup = job({ name: "backup-main", kind: "backup", last_run: { id: "r", job: "backup-main", trigger: "schedule", status: "failed", started_at: ago(HOUR) } });
    expect(items({ jobs: [backup] })).toEqual([]);
  });
});

describe("databases", () => {
  const ok = (at: number) => ({ id: "b", status: "succeeded" as const, started_at: ago(at), finished_at: ago(at) });

  it("flags a failed backup as critical with the cause and the database page", () => {
    const [item] = items({ databases: [database({ last_run: { id: "b", status: "failed", started_at: ago(HOUR), finished_at: ago(HOUR - MIN), detail: "pg_dump: connection refused" } })] });
    expect(item).toMatchObject({ severity: "critical", kind: "backup", message: "Last backup of main failed: pg_dump: connection refused" });
    expect(item.actions).toEqual([{ label: "Database", href: "/servers/s1/databases/main" }]);
  });

  it("flags a missing backup only when nothing is scheduled: a first backup that is scheduled is just waiting", () => {
    expect(items({ databases: [database({ last_run: null })] })).toEqual([]);
    expect(items({ databases: [database({ last_run: null, next_run: null })] })[0]).toMatchObject({ severity: "warning", message: "main has no backup yet and none is scheduled" });
  });

  it("flags a backup overdue by more than twice its period (daily: after 48 h), not before", () => {
    expect(items({ databases: [database({ last_run: ok(47 * HOUR) })] })).toEqual([]);
    const [item] = items({ databases: [database({ last_run: ok(50 * HOUR) })] });
    expect(item).toMatchObject({ severity: "warning", kind: "backup" });
    expect(item.message).toContain("2 d ago");
    expect(item.since).toBe(ago(2 * HOUR));
  });

  it("ignores paused backups and databases without a backup", () => {
    expect(items({ databases: [database({ paused: true, last_run: ok(500 * HOUR) }), database(null)] })).toEqual([]);
  });
});

describe("proxy and host", () => {
  it("flags a proxy out of sync and one that cannot be read", () => {
    const base = { type: "caddy" as const, where: "", generated: "", routes: [], unrouted: [] };
    expect(items({ proxy: { ...base, in_sync: false } })[0]).toMatchObject({ severity: "warning", kind: "proxy" });
    expect(items({ proxy: { ...base, live_error: "dial refused" } })[0].message).toBe("The proxy could not be read: dial refused");
    expect(items({ proxy: { ...base, in_sync: true } })).toEqual([]);
  });

  it("links an out-of-sync proxy to the Proxy page of the server, not to a ?tab= of its overview", () => {
    const base = { type: "caddy" as const, where: "", generated: "", routes: [], unrouted: [] };
    expect(items({ proxy: { ...base, in_sync: false } })[0].actions).toEqual([{ label: "Proxy", href: "/servers/s1/proxy" }]);
  });

  it("flags disk and memory pressure and a Docker that does not answer", () => {
    const list = items({ system: { ...system({ disk: { path: "/", total: 100 * GIB, free: 3 * GIB }, memory: { total: 4 * GIB, available: 0.5 * GIB, swap_total: 0, swap_free: 0 } }), engine_error: "no docker" } });
    expect(list.map((i) => `${i.kind}:${i.severity}`).sort()).toEqual(["disk:critical", "engine:critical", "memory:warning"]);
  });
});

describe("unreachable servers", () => {
  it("is a warning saying how long it has been, with the reason, and hides nothing else", () => {
    const down = snap({ reachable: false, reason: "connect ECONNREFUSED", lastSeen: NOW - 12 * MIN, apps: undefined });
    const other = { ...snap({ apps: [app({}, { running: false, exit_code: 1, finished_at: ago(MIN) })] }), server: { id: "s2", name: "vps-2" } };
    const list = attentionItems([down, other], NOW);
    const item = list.find((i) => i.kind === "unreachable")!;
    expect(item).toMatchObject({ severity: "warning", message: "vps-1 did not answer (connect ECONNREFUSED); last answered 12 min ago", since: new Date(NOW - 12 * MIN).toISOString() });
    expect(list.some((i) => i.kind === "app-down" && i.server.id === "s2")).toBe(true);
  });

  it("says when the dashboard never had an answer", () => {
    expect(attentionItems([snap({ reachable: false, lastSeen: null })], NOW)[0].message).toContain("never had an answer");
  });
});

describe("ranking and verdict", () => {
  it("sorts critical before warning before info, then the newest first, items without a time last", () => {
    const list = items({
      apps: [app({ name: "a", last_deployment: deployment({ status: "failed", finished_at: ago(HOUR) }) }, null), app({ name: "b", last_deployment: null }, null), app({ name: "c" }, { running: false, exit_code: 1, finished_at: ago(MIN) })],
      jobs: [job({ name: "j", last_run: { id: "r", job: "j", trigger: "schedule", status: "failed", started_at: ago(5 * MIN), finished_at: ago(4 * MIN) } })],
      proxy: { type: "nginx", where: "", generated: "", routes: [], unrouted: [], in_sync: false },
    });
    expect(list.map((i) => `${i.severity}:${i.kind}:${i.subject}`)).toEqual([
      "critical:app-down:c",
      "warning:job:j",
      "warning:deployment:a",
      "warning:proxy:proxy",
      "info:app-down:b",
    ]);
  });

  it("never says everything is fine while any item exists, and takes its tone from the worst", () => {
    const info = items({ apps: [app({ last_deployment: null }, null)] });
    expect(summarize(info)).toEqual({ tone: "info", label: "1 thing needs attention", count: 1 });
    const warn = items({ jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", started_at: ago(MIN) } })] });
    expect(summarize(warn).tone).toBe("warning");
    expect(summarize([...info, ...items({ apps: [app({}, { running: false, exit_code: 1 })] })])).toMatchObject({ tone: "danger", label: "2 things need attention" });
    expect(summarize(items({ apps: [app({}, { running: false, exit_code: 0 })] })).label).not.toBe("Everything is fine");
  });

  it("filters the items of one server", () => {
    const a = snap({ apps: [app({}, { running: false, exit_code: 1 })] });
    const b = { ...snap({ jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", started_at: ago(MIN) } })] }), server: { id: "s2", name: "vps-2" } };
    const list = attentionItems([a, b], NOW);
    expect(itemsOf(list, "s1").every((i) => i.server.id === "s1")).toBe(true);
    expect(itemsOf(list, "s2").map((i) => i.kind)).toEqual(["job"]);
  });
});

describe("helpers", () => {
  it("says what stands in place of an empty list when a server did not answer", () => {
    expect(cantTell([{ name: "vps-1", reason: "timeout" }])).toBe("Can't tell: vps-1 did not answer (timeout)");
    expect(cantTell([{ name: "a" }, { name: "b", reason: "refused" }])).toBe("Can't tell: a, b did not answer (refused)");
  });

  it("shortens spans and error lines", () => {
    expect(spanText(40_000)).toBe("40 s");
    expect(spanText(50 * MIN)).toBe("50 min");
    expect(spanText(5 * HOUR)).toBe("5 h");
    expect(spanText(72 * HOUR)).toBe("3 d");
    expect(firstLine("\n  boom  \nmore")).toBe("boom");
    expect(firstLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("reads the version of an image reference", () => {
    expect(imageVersion("ghcr.io/acme/shop:v1.4.2")).toEqual({ repository: "acme/shop", version: "v1.4.2" });
    expect(imageVersion("localhost:5000/shop")).toEqual({ repository: "shop", version: "latest" });
    expect(imageVersion("acme/shop@sha256:0123456789abcdef0123")).toEqual({ repository: "acme/shop", version: "sha256:0123456789ab" });
    expect(imageVersion(`ghcr.io/acme/shop:${"ab12".repeat(10)}`).version).toBe("ab12ab12ab12");
    expect(imageVersion("nginx:alpine")).toEqual({ repository: "nginx", version: "alpine" });
  });
});

describe("schedule periods", () => {
  it("reads descriptors, cron expressions and @every", () => {
    expect(schedulePeriodMs("@hourly")).toBe(HOUR);
    expect(schedulePeriodMs("0 3 * * *")).toBe(24 * HOUR);
    expect(schedulePeriodMs("*/15 * * * *")).toBe(15 * MIN);
    expect(schedulePeriodMs("@every 1h30m")).toBe(90 * MIN);
    expect(schedulePeriodMs("0 0 * * 0")).toBe(7 * 24 * HOUR);
  });
  it("takes the longest gap of an irregular schedule and gives up on nonsense", () => {
    expect(schedulePeriodMs("0 9 * * mon-fri")).toBe(3 * 24 * HOUR);
    expect(schedulePeriodMs("0 0 1 * *")).toBeGreaterThanOrEqual(28 * 24 * HOUR);
    expect(schedulePeriodMs("nonsense")).toBeNull();
    expect(schedulePeriodMs("61 * * * *")).toBeNull();
  });
});
