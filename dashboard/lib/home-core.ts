import type { AttentionItem } from "@/lib/attention-core";
import type { AppStatus, DatabaseStatus, Deployment, JobRun, JobStatus } from "@/lib/agent-types";
import { jobsOf, type Placement } from "@/lib/projects-core";
import type { Tone } from "@/lib/status";

// What the home page derives from the fleet besides the attention list: the headline, the apps as placements, and the
// last day's events. Pure, so the page stays a layout.

export interface HomeServer {
  server: { id: string; name: string };
  reachable: boolean;
  reason?: string;
  canDeploy: boolean;
  apps?: AppStatus[] | null;
  jobs?: JobStatus[] | null;
  deployments?: Deployment[];
}

export interface Headline {
  tone: Tone;
  /** "All good", "2 things need attention", or while nothing is watched yet "Not set up yet" / "Nothing deployed yet". */
  text: string;
  reachable: number;
  total: number;
}

/**
 * The first line of the page: is everything fine, and does the dashboard hear every agent. "All good" is said only when
 * something is being watched: with no server, or no app on any server, there is nothing to be good about and the tone is neutral.
 */
export function headline(items: AttentionItem[], servers: { reachable: boolean; apps?: unknown[] | null }[]): Headline {
  const reachable = servers.filter((s) => s.reachable).length;
  const total = servers.length;
  if (items.length === 0) {
    if (total === 0) return { tone: "muted", text: "Not set up yet", reachable, total };
    if (!servers.some((s) => s.reachable && (s.apps?.length ?? 0) > 0)) return { tone: "muted", text: "Nothing deployed yet", reachable, total };
    return { tone: "success", text: "All good", reachable, total };
  }
  const critical = items.some((i) => i.severity === "critical");
  const warning = items.some((i) => i.severity === "warning");
  return {
    tone: critical ? "danger" : warning ? "warning" : "info",
    text: items.length === 1 ? "1 thing needs attention" : `${items.length} things need attention`,
    reachable,
    total: servers.length,
  };
}

/** Every app of every reachable server, with its jobs: what projects are grouped from. */
export function placementsOf(servers: HomeServer[]): Placement[] {
  return servers.flatMap((s) =>
    (s.reachable ? (s.apps ?? []) : []).map((app): Placement => ({ server: { ...s.server, canDeploy: s.canDeploy }, app, jobs: jobsOf(app.name, s.jobs ?? []) })),
  );
}

export interface RecentEvent {
  id: string;
  kind: "deployment" | "job";
  server: { id: string; name: string };
  subject: string;
  /** A deployment status or a job run status. */
  status: string;
  /** What started the deployment (`status` and it tell a roll back from a deploy); absent for a job run. */
  trigger?: string;
  /** The image the deployment put in service (a roll back that worked says which version it went back to); absent for a job run. */
  image?: string;
  /** The error or failure detail, one line when there is one. */
  detail?: string;
  at: string;
  href: string;
}

export const RECENT_WINDOW_MS = 24 * 3600_000;

/** Deployments of the last 24 h and failed job runs of the last 24 h, newest first, at most `limit`. */
export function recentEvents(servers: HomeServer[], now: number, limit = 8): RecentEvent[] {
  const since = now - RECENT_WINDOW_MS;
  const events: RecentEvent[] = [];
  for (const s of servers) {
    if (!s.reachable) continue;
    for (const d of s.deployments ?? []) {
      if (Date.parse(d.started_at) < since) continue;
      events.push({ id: `${s.server.id}:d:${d.id}`, kind: "deployment", server: s.server, subject: d.app, status: d.status, trigger: d.trigger, image: d.ref, detail: d.error, at: d.started_at, href: `/servers/${s.server.id}/deployments/${d.id}` });
    }
    for (const j of s.jobs ?? []) {
      const run: JobRun | undefined = j.last_run;
      if (!run || run.status !== "failed" || Date.parse(run.started_at) < since) continue;
      events.push({ id: `${s.server.id}:j:${j.name}:${run.id}`, kind: "job", server: s.server, subject: j.name, status: run.status, detail: run.detail, at: run.started_at, href: `/servers/${s.server.id}/jobs/${encodeURIComponent(j.name)}` });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

// The figures and the ribbon of the home page's first block: what the fleet is doing, at a glance. Derived from the same
// data as the lists below it, so the block can never say something the lists do not.

export interface FleetFigures {
  /** Apps whose container runs and is neither restarting nor reported unhealthy, of the apps of reachable servers. */
  appsUp: number;
  appsTotal: number;
  /** Deployments started in the last 24 hours, and how many of them did not end well (failed, rolled back, could not roll back). */
  deployments: number;
  failedDeployments: number;
  /** Databases with a backup schedule whose latest finished run succeeded, of those with one (a run in progress or skipped does not count either way). */
  backupsHealthy: number;
  backupsTotal: number;
}

const BAD_DEPLOYMENT = new Set(["failed", "rolled_back", "rollback_failed"]);

export function fleetFigures(servers: (HomeServer & { databases?: DatabaseStatus[] | null })[], now: number): FleetFigures {
  const since = now - RECENT_WINDOW_MS;
  const f: FleetFigures = { appsUp: 0, appsTotal: 0, deployments: 0, failedDeployments: 0, backupsHealthy: 0, backupsTotal: 0 };
  for (const s of servers) {
    if (!s.reachable) continue;
    for (const a of s.apps ?? []) {
      f.appsTotal++;
      const c = a.container?.state;
      if (c && c.running && !c.restarting && c.health !== "unhealthy") f.appsUp++;
    }
    for (const d of s.deployments ?? []) {
      if (Date.parse(d.started_at) < since || Date.parse(d.started_at) > now) continue;
      f.deployments++;
      if (BAD_DEPLOYMENT.has(d.status)) f.failedDeployments++;
    }
    for (const db of s.databases ?? []) {
      const b = db.backup;
      if (!b || b.paused) continue;
      const status = b.last_run?.status;
      if (status === "running" || status === "skipped" || status === undefined) continue;
      f.backupsTotal++;
      if (status === "succeeded") f.backupsHealthy++;
    }
  }
  return f;
}

/** One hour of the last day: what happened in it, worst first. */
export interface DayBucket {
  /** Start of the hour (ms); the last bucket ends at `now`. */
  from: number;
  deployments: number;
  /** The worst outcome in the hour: a failed or rolled back deployment or a failed job run beats a success, which beats nothing. */
  worst: "none" | "ok" | "warning" | "failed";
  /** For the tooltip and the screen reader: "3 deployments, 1 failed". */
  summary: string;
}

/** 24 hourly buckets, oldest first, the last one ending at `now`. An event outside the window is ignored. */
export function dayBuckets(events: Pick<RecentEvent, "kind" | "status" | "at">[], now: number): DayBucket[] {
  const HOUR = 3600_000;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ from: now - (24 - i) * HOUR, deployments: 0, failed: 0, rolled: 0, jobsFailed: 0, ok: 0 }));
  for (const e of events) {
    const t = Date.parse(e.at);
    const i = Math.floor((t - (now - 24 * HOUR)) / HOUR);
    if (!(t <= now) || i < 0 || i > 23) continue;
    const b = buckets[i];
    if (e.kind === "job") {
      if (e.status === "failed") b.jobsFailed++;
      continue;
    }
    b.deployments++;
    if (e.status === "succeeded") b.ok++;
    else if (e.status === "rolled_back") b.rolled++;
    else if (BAD_DEPLOYMENT.has(e.status)) b.failed++;
  }
  return buckets.map((b) => {
    const worst: DayBucket["worst"] = b.failed + b.jobsFailed > 0 ? "failed" : b.rolled > 0 ? "warning" : b.ok > 0 ? "ok" : "none";
    const parts: string[] = [];
    if (b.deployments > 0) parts.push(`${b.deployments} deployment${b.deployments === 1 ? "" : "s"}`);
    if (b.failed > 0) parts.push(`${b.failed} failed`);
    if (b.rolled > 0) parts.push(`${b.rolled} rolled back`);
    if (b.jobsFailed > 0) parts.push(`${b.jobsFailed} failed job run${b.jobsFailed === 1 ? "" : "s"}`);
    return { from: b.from, deployments: b.deployments, worst, summary: parts.length > 0 ? parts.join(", ") : "nothing" };
  });
}
