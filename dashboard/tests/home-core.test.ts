import { describe, expect, it } from "vitest";
import type { AppStatus, Deployment, JobStatus } from "@/lib/agent-types";
import type { AttentionItem } from "@/lib/attention-core";
import { dayBuckets, fleetFigures, headline, placementsOf, recentEvents, type HomeServer } from "@/lib/home-core";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const item = (severity: AttentionItem["severity"]): AttentionItem => ({ id: severity, severity, kind: "job", server: { id: "s", name: "s" }, subject: "x", message: "m", since: null, actions: [] });
const dep = (id: string, over: Partial<Deployment> = {}): Deployment => ({ id, app: "shop", ref: "i:v1", status: "succeeded", trigger: "api", started_at: ago(HOUR), ...over });
const server = (over: Partial<HomeServer> = {}): HomeServer => ({ server: { id: "s1", name: "vps-1" }, reachable: true, canDeploy: true, ...over });

describe("headline", () => {
  it("says all good when something is watched and nothing needs attention, and counts the agents that answer", () => {
    const app = [{}];
    expect(headline([], [{ reachable: true, apps: app }, { reachable: true }])).toEqual({ tone: "success", text: "All good", reachable: 2, total: 2 });
  });
  it("is neutral, never 'All good', with no server connected", () => {
    expect(headline([], [])).toEqual({ tone: "muted", text: "Not set up yet", reachable: 0, total: 0 });
  });
  it("is neutral with servers but no app on any of them (a down server's apps do not count)", () => {
    expect(headline([], [{ reachable: true, apps: [] }, { reachable: true, apps: null }, { reachable: true }])).toMatchObject({ tone: "muted", text: "Nothing deployed yet" });
    expect(headline([], [{ reachable: false, apps: [{}] }])).toMatchObject({ tone: "muted", text: "Nothing deployed yet" });
  });
  it("counts the things and takes the worst severity", () => {
    expect(headline([item("info")], [{ reachable: true }])).toMatchObject({ tone: "info", text: "1 thing needs attention" });
    expect(headline([item("warning"), item("critical")], [{ reachable: true }, { reachable: false }])).toEqual({ tone: "danger", text: "2 things need attention", reachable: 1, total: 2 });
    expect(headline([item("warning")], [{ reachable: false }]).tone).toBe("warning");
  });
});

describe("placementsOf", () => {
  it("lists the apps of reachable servers with their jobs, and nothing for a server that did not answer", () => {
    const app = { name: "shop" } as AppStatus;
    const j = { name: "j", kind: "container", target: "container of shop" } as JobStatus;
    const list = placementsOf([server({ apps: [app], jobs: [j] }), server({ server: { id: "s2", name: "down" }, reachable: false, apps: [app] })]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ server: { id: "s1", canDeploy: true }, jobs: [j] });
  });
});

describe("recentEvents", () => {
  it("takes deployments and failed job runs of the last 24 h, newest first, at most 8", () => {
    const failedJob = { name: "nightly", last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", detail: "boom", started_at: ago(30 * 60_000) } } as JobStatus;
    const okJob = { name: "ok", last_run: { id: "r2", job: "ok", trigger: "schedule", status: "succeeded", started_at: ago(HOUR) } } as JobStatus;
    const list = recentEvents([server({ deployments: [dep("old", { started_at: ago(25 * HOUR) }), dep("new", { started_at: ago(2 * HOUR), status: "failed", error: "x" })], jobs: [failedJob, okJob] })], NOW);
    expect(list.map((e) => e.id)).toEqual(["s1:j:nightly:r", "s1:d:new"]);
    expect(list[0]).toMatchObject({ kind: "job", detail: "boom", href: "/servers/s1/jobs/nightly" });
    expect(list[1]).toMatchObject({ kind: "deployment", trigger: "api", image: "i:v1" });
    const many = Array.from({ length: 12 }, (_, i) => dep(`d${i}`, { started_at: ago((i + 1) * 60_000) }));
    expect(recentEvents([server({ deployments: many })], NOW)).toHaveLength(8);
    expect(recentEvents([server({ deployments: many })], NOW)[0].id).toBe("s1:d:d0");
  });
  it("skips servers that did not answer", () => {
    expect(recentEvents([server({ reachable: false, deployments: [dep("a")] })], NOW)).toEqual([]);
  });
});

describe("fleetFigures", () => {
  const app = (running: boolean, extra: Record<string, unknown> = {}) => ({ name: "a", container: { state: { running, restarting: false, ...extra } } }) as unknown as AppStatus;
  const db = (run: string | null, over: Record<string, unknown> = {}) => ({ name: "d", backup: { paused: false, last_run: run === null ? null : { status: run }, ...over } }) as never;

  it("counts the apps that run and are not restarting or unhealthy, only on servers that answer", () => {
    const f = fleetFigures(
      [
        server({ apps: [app(true), app(true, { health: "unhealthy" }), app(true, { restarting: true }), app(false), { name: "none", container: null } as AppStatus, app(true, { health: "healthy" })] }),
        server({ server: { id: "s2", name: "down" }, reachable: false, apps: [app(true)] }),
      ],
      NOW,
    );
    expect(f).toMatchObject({ appsUp: 2, appsTotal: 6 });
  });

  it("counts the deployments of the last day and the ones that did not end well", () => {
    const f = fleetFigures(
      [server({ deployments: [dep("1"), dep("2", { status: "failed" }), dep("3", { status: "rolled_back" }), dep("4", { status: "rollback_failed" }), dep("5", { status: "running" }), dep("6", { started_at: ago(25 * HOUR) })] })],
      NOW,
    );
    expect(f).toMatchObject({ deployments: 5, failedDeployments: 3 });
  });

  it("counts a backup as healthy when its latest finished run succeeded; a paused one, one in progress and one never run say nothing", () => {
    const f = fleetFigures([server({ databases: [db("succeeded"), db("failed"), db("missed"), db("running"), db("skipped"), db(null), db("succeeded", { paused: true }), { name: "plain", backup: null } as never] } as Partial<HomeServer>)], NOW);
    expect(f).toMatchObject({ backupsHealthy: 1, backupsTotal: 3 });
  });
});

describe("dayBuckets", () => {
  const ev = (at: number, status: string, kind: "deployment" | "job" = "deployment") => ({ kind, status, at: new Date(at).toISOString() });

  it("is 24 hourly buckets, oldest first, the last ending now", () => {
    const b = dayBuckets([], NOW);
    expect(b).toHaveLength(24);
    expect(b[23].from).toBe(NOW - HOUR);
    expect(b[0].from).toBe(NOW - 24 * HOUR);
    expect(b.every((x) => x.worst === "none" && x.summary === "nothing")).toBe(true);
  });

  it("puts each event in its hour and keeps the worst outcome of the hour", () => {
    const b = dayBuckets([ev(NOW - 30 * 60_000, "succeeded"), ev(NOW - 20 * 60_000, "failed"), ev(NOW - 5 * HOUR - 60_000, "rolled_back"), ev(NOW - 5 * HOUR - 2 * 60_000, "succeeded"), ev(NOW - 10 * HOUR, "failed", "job")], NOW);
    expect(b[23]).toMatchObject({ worst: "failed", deployments: 2, summary: "2 deployments, 1 failed" });
    expect(b[18]).toMatchObject({ worst: "warning", summary: "2 deployments, 1 rolled back" });
    expect(b[14]).toMatchObject({ worst: "failed", deployments: 0, summary: "1 failed job run" });
    expect(b.filter((x) => x.worst !== "none")).toHaveLength(3);
  });

  it("calls a succeeded hour ok and ignores what is outside the window or in the future", () => {
    const b = dayBuckets([ev(NOW - 90 * 60_000, "succeeded"), ev(NOW - 25 * HOUR, "failed"), ev(NOW + HOUR, "failed")], NOW);
    expect(b[22]).toMatchObject({ worst: "ok", summary: "1 deployment" });
    expect(b.filter((x) => x.worst === "failed")).toHaveLength(0);
  });
});
