import type { AlertRecord, AuditEntry as AgentAuditEntry, ConfigVersion, Deployment, JobRun } from "@/lib/agent-types";
import { describeAgentAudit, describeDashboardAudit, dashboardAuditHref, type ActivityKind } from "@/lib/audit-core";
import type { AuditEntry as DashboardAuditEntry } from "@/lib/auth/store";
import { deployEnding, deployNoun } from "@/lib/labels-core";
import { runAnchor } from "@/lib/run-core";
import { deploymentStatus, jobRunStatus, type Tone } from "@/lib/status";
import { serverActivityHref } from "@/lib/redirects-core";

// The Activity feed: what happened across the fleet, newest first. Everything here is pure: the loader fetches what each
// agent says (deployments, job runs, restores, its audit log) and the dashboard's own audit entries, this merges, matches
// the agent's audit entries to the deployments and runs they started (so a row says who did it), filters and pages.
// Alerts are listed too: the agent keeps the last 200 notifications it raised with how their delivery ended, and the loader
// asks each server for them. A server whose agent predates that history says nothing here; one that fails to answer is a gap.

export interface ActivityServer {
  id: string;
  name: string;
}

export const WINDOWS = { "1h": 3600_000, "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000 } as const;
export type ActivityWindow = keyof typeof WINDOWS;
export const DEFAULT_WINDOW: ActivityWindow = "7d";

/** What an Activity row is about: the audit kinds, and the alerts the agents raised. */
export type FeedKind = ActivityKind | "alert";

export const KINDS: FeedKind[] = ["deployment", "job", "backup", "alert", "change", "security"];

export const FEED_KIND_LABELS: Record<FeedKind, string> = {
  deployment: "Deployments",
  job: "Jobs",
  backup: "Backups",
  alert: "Alerts",
  change: "Config changes",
  security: "Security",
};

/** Rows per page, and the most the page ever shows: "load more" asks for another page up to this. */
export const PAGE_SIZE = 40;
export const MAX_ROWS = 200;

/** What one row shows. */
export interface ActivityEvent {
  /** Unique and stable across refreshes. */
  id: string;
  kind: FeedKind;
  at: string;
  /** Absent for what concerns the dashboard as a whole (sign-ins, tokens, integrations). */
  server?: ActivityServer;
  tone: Tone;
  /** "Succeeded", "Failed", "Done", "Refused"... */
  status: string;
  /** Still going: the status pulses. */
  live?: boolean;
  /** Counts for the "failed only" filter: something that did not work, or was undone. */
  failed: boolean;
  /** One line, in words: "Deployed web". */
  summary: string;
  /** The app, job, database or container named by the summary, as a link when it has a page. */
  subject?: { label: string; href?: string };
  /** The image reference of a deployment: shown as a chip whose tag is never cut. */
  ref?: string;
  /** The error line or what else the entry says. */
  note?: string;
  /** Who did it, when known: "dashboard", "token:ci". */
  actor?: string;
  /** What started it, in words: "Schedule", "GitHub webhook". */
  trigger?: string;
  /** The app (or database, job) this is about: what the app filter matches. */
  app?: string;
  project?: string;
  /** The detail: the deployment, the run, the settings page. */
  href?: string;
  /** Where the output of a job run is, when it has one. */
  outputHref?: string;
  /** An alert's severity as the agent names it ("critical", "warning", "info"). */
  severity?: string;
}

// ---- Input -------------------------------------------------------------------------------------------------------------

export interface RunInput {
  run: JobRun;
  /** The job as the agent names it. */
  job: string;
  /** A database's backup job, or one of its restores. */
  database?: { name: string; what: "backup" | "restore" };
  /** The app a container job acts on. */
  app?: string;
}

/** What one server said. A server that did not answer has `unreachable` and nothing else. */
export interface ServerActivity {
  server: ActivityServer;
  unreachable?: string;
  deployments: Deployment[];
  runs: RunInput[];
  audit: AgentAuditEntry[];
  versions: ConfigVersion[];
  /** The notifications this server raised, newest first; absent for an agent that does not keep them. */
  alerts?: AlertRecord[];
  /** App name to project name, for the project filter. */
  projects: Record<string, string>;
  /** The sources that failed on a server that did answer: what is missing from its part of the feed, and why. */
  gaps: { source: string; reason: string }[];
}

// ---- Rows --------------------------------------------------------------------------------------------------------------

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** The first line that says something. */
const firstLine = (text: string | undefined) => clip((text ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "", 220);

const DEPLOY_FAILED = new Set(["failed", "rollback_failed", "rolled_back"]);

/** What a deployment did, in the words of the three verbs: Deploy, Roll back, Promote. */
const DEPLOY_WORDS: Record<string, { running: string; done: string }> = {
  deploy: { running: "Deploying", done: "Deployed" },
  rollback: { running: "Rolling back", done: "Rolled back" },
  promotion: { running: "Promoting", done: "Promoted" },
};

function deploymentSummary(d: Deployment): string {
  const words = DEPLOY_WORDS[d.trigger] ?? DEPLOY_WORDS.deploy;
  const noun = deployNoun(d.trigger);
  switch (d.status) {
    case "running":
      return `${words.running} ${d.app}`;
    case "succeeded":
      return `${words.done} ${d.app}`;
    default:
      return `${noun} of ${d.app} ${deployEnding(d.trigger, d.status)}`;
  }
}

function deploymentEvent(s: ServerActivity, d: Deployment, trigger: (t: string) => string): ActivityEvent {
  const view = deploymentStatus(d.status, d.trigger, d.ref);
  return {
    id: `${s.server.id}:d:${d.id}`,
    kind: "deployment",
    at: d.started_at,
    server: s.server,
    tone: view.tone,
    status: view.label,
    live: view.live,
    failed: DEPLOY_FAILED.has(d.status),
    summary: deploymentSummary(d),
    subject: { label: d.app, href: `/servers/${s.server.id}/apps/${encodeURIComponent(d.app)}` },
    ref: d.ref,
    note: d.error ? firstLine(d.error) : undefined,
    trigger: trigger(d.trigger),
    app: d.app,
    project: s.projects[d.app],
    href: `/servers/${s.server.id}/deployments/${encodeURIComponent(d.id)}`,
  };
}

function runSummary(r: RunInput): string {
  const { status } = r.run;
  const word = status === "running" ? "is running" : status === "succeeded" ? "succeeded" : status === "skipped" ? "was skipped" : "failed";
  if (r.database?.what === "backup") return `Backup of ${r.database.name} ${word}`;
  if (r.database?.what === "restore") return `Restore of ${r.database.name} ${word}`;
  return `Job ${r.job} ${word}`;
}

function runEvent(s: ServerActivity, r: RunInput, trigger: (t: string) => string): ActivityEvent {
  const view = jobRunStatus(r.run.status);
  const base = `/servers/${s.server.id}`;
  const page = r.database ? `${base}/databases/${encodeURIComponent(r.database.name)}` : `${base}/jobs/${encodeURIComponent(r.job)}`;
  const href = `${page}?run=${encodeURIComponent(r.run.id)}#${runAnchor(r.run.id)}`;
  return {
    id: `${s.server.id}:r:${r.job}:${r.run.id}`,
    kind: r.database ? "backup" : "job",
    at: r.run.started_at,
    server: s.server,
    tone: view.tone,
    status: view.label,
    live: view.live,
    failed: r.run.status === "failed",
    summary: runSummary(r),
    subject: { label: r.database ? r.database.name : r.job, href: page },
    note: r.run.detail ? firstLine(r.run.detail) : undefined,
    trigger: trigger(r.run.trigger),
    app: r.database ? r.database.name : (r.app ?? undefined),
    project: r.app === undefined ? undefined : s.projects[r.app],
    href,
    ...(r.run.output ? { outputHref: href } : {}),
  };
}

/** How a notification's delivery ended, in the words of the badge. */
const DELIVERY: Record<string, { label: string; tone: Tone; failed: boolean }> = {
  delivered: { label: "Delivered", tone: "success", failed: false },
  partial: { label: "Partly delivered", tone: "warning", failed: true },
  failed: { label: "Not delivered", tone: "danger", failed: true },
  no_channel: { label: "Not sent", tone: "muted", failed: false },
  dropped: { label: "Dropped", tone: "muted", failed: false },
  suppressed: { label: "Suppressed", tone: "muted", failed: false },
};

/** The delivery of a notification as a badge: a status the dashboard does not know is shown as it came, never hidden. */
export function deliveryView(status: string): { label: string; tone: Tone; failed: boolean } {
  return DELIVERY[status] ?? { label: status === "" ? "Unknown" : status, tone: "muted", failed: false };
}

const DELIVERY_NOTE: Record<string, string> = {
  no_channel: "No alert channel is set up on this server",
  dropped: "The queue was full: the notification was never sent",
  suppressed: "Held back by the cooldown",
};

/** Whether a notification is one whose delivery went wrong: partly or not at all. */
export const deliveryFailed = (status: string): boolean => deliveryView(status).failed;

function alertEvent(s: ServerActivity, a: AlertRecord): ActivityEvent {
  const view = deliveryView(a.status);
  const base = `/servers/${s.server.id}`;
  const note =
    (a.failed_channels?.length ?? 0) > 0
      ? `Failed on ${a.failed_channels!.join(", ")}`
      : (DELIVERY_NOTE[a.status] ?? (a.message ? firstLine(a.message) : undefined));
  return {
    id: `${s.server.id}:a:${a.time}:${a.type}:${a.app ?? a.job ?? ""}:${a.deployment_id ?? ""}`,
    kind: "alert",
    at: a.time,
    server: s.server,
    tone: view.tone,
    status: view.label,
    failed: view.failed,
    summary: clip(a.title, 220),
    subject: a.app === undefined ? undefined : { label: a.app, href: `${base}/apps/${encodeURIComponent(a.app)}` },
    ...(a.ref === undefined ? {} : { ref: a.ref }),
    note,
    severity: a.severity,
    app: a.app,
    project: a.app === undefined ? undefined : s.projects[a.app],
    href: a.deployment_id === undefined ? undefined : `${base}/deployments/${encodeURIComponent(a.deployment_id)}`,
  };
}

/** The window an agent's audit entry can be told from a deployment it started: the entry is written once the request is answered. */
const BEFORE_MS = 60_000;
const AFTER_MS = 5_000;

/** What an accepted request of this kind started: a deployment of an app, or a run of a job. */
function startedBy(entry: AgentAuditEntry): { type: "deployment" | "run"; subject: string } | null {
  const app = /^\/v1\/apps\/([^/]+)\//.exec(entry.path)?.[1];
  const job = /^\/v1\/jobs\/([^/]+)\/run$/.exec(entry.path)?.[1];
  const database = /^\/v1\/databases\/([^/]+)\/restore$/.exec(entry.path)?.[1];
  switch (entry.action) {
    case "deploy":
    case "rollback":
    case "build":
      return app === undefined ? null : { type: "deployment", subject: decodeURIComponent(app) };
    case "preview.deploy":
      // The detail is "<instance> tag=x": the instance is what the deployment is recorded under.
      return entry.detail ? { type: "deployment", subject: entry.detail.split(" ")[0] } : null;
    case "job.run":
      return job === undefined ? null : { type: "run", subject: decodeURIComponent(job) };
    case "database.restore":
      return database === undefined ? null : { type: "run", subject: `restore-${decodeURIComponent(database)}` };
    default:
      return null;
  }
}

/**
 * The agent's audit entries a deployment or a run already tells: an accepted deploy, rollback, build, job run or restore
 * is the row of what it started, and names who asked. Returns the entries that are left to show on their own (refused
 * ones, and accepted ones whose deployment or run is not among those fetched).
 */
function attachActors(events: Map<string, { event: ActivityEvent; subject: string; type: "deployment" | "run" }>, audit: AgentAuditEntry[]): AgentAuditEntry[] {
  const claimed = new Set<string>();
  const left: AgentAuditEntry[] = [];
  for (const entry of audit) {
    const started = entry.status < 400 ? startedBy(entry) : null;
    if (started === null) {
      left.push(entry);
      continue;
    }
    const at = Date.parse(entry.at);
    let best: { id: string; distance: number } | undefined;
    for (const [id, e] of events) {
      if (claimed.has(id) || e.type !== started.type || e.subject !== started.subject) continue;
      const delta = at - Date.parse(e.event.at);
      if (delta < -AFTER_MS || delta > BEFORE_MS) continue;
      if (best === undefined || Math.abs(delta) < best.distance) best = { id, distance: Math.abs(delta) };
    }
    if (best === undefined) {
      left.push(entry);
      continue;
    }
    claimed.add(best.id);
    const target = events.get(best.id);
    if (target && entry.actor) target.event.actor = entry.actor;
  }
  return left;
}

function agentAuditEvent(s: ServerActivity, e: AgentAuditEntry): ActivityEvent {
  const line = describeAgentAudit(e, s.server.id, s.versions);
  const { target } = line;
  const app = target.kind === "app" ? target.text : undefined;
  return {
    id: `${s.server.id}:a:${e.id}`,
    kind: line.kind,
    at: e.at,
    server: s.server,
    tone: line.outcome.ok ? "muted" : line.outcome.tone,
    status: line.outcome.ok ? "Done" : line.outcome.label,
    failed: !line.outcome.ok,
    summary: line.sentence,
    subject: target.text === "" ? undefined : { label: target.text, href: target.href },
    note: target.note === undefined ? undefined : clip(target.note, 200),
    actor: e.actor,
    app,
    project: app === undefined ? undefined : s.projects[app],
    href: target.versionHref ?? target.href ?? serverActivityHref(s.server.id),
  };
}

function dashboardAuditEvent(e: DashboardAuditEntry): ActivityEvent | null {
  const line = describeDashboardAudit(e);
  if (!line.feed) return null;
  const ip = e.ip && e.ip !== "local" && e.ip !== "unknown" ? `from ${e.ip}` : undefined;
  return {
    id: `dash:${e.id}`,
    kind: line.kind,
    at: new Date(e.at).toISOString(),
    tone: line.tone === "danger" ? "danger" : "muted",
    status: line.tone === "danger" ? "Failed" : "Done",
    failed: line.tone === "danger",
    summary: clip(line.sentence, 200),
    note: ip,
    actor: e.actor ?? undefined,
    href: dashboardAuditHref(e.event),
  };
}

// ---- The feed ----------------------------------------------------------------------------------------------------------

export interface ActivityFilter {
  kind?: FeedKind;
  /** A server id. */
  server?: string;
  project?: string;
  app?: string;
  failed: boolean;
  window: ActivityWindow;
  limit: number;
}

type Param = string | string[] | undefined;
const first = (p: Param) => (Array.isArray(p) ? p[0] : p);

/** The filter a URL asks for: anything unrecognised falls back to the default instead of failing. */
export function parseFilter(params: Record<string, Param>): ActivityFilter {
  const text = (p: Param) => {
    const v = first(p);
    return v === undefined || v === "" ? undefined : v.slice(0, 100);
  };
  const kind = first(params.kind);
  const window = first(params.window);
  const limit = Number(first(params.limit));
  return {
    kind: KINDS.find((k) => k === kind),
    server: text(params.server),
    project: text(params.project),
    app: text(params.app),
    failed: first(params.failed) === "1",
    window: (Object.keys(WINDOWS) as ActivityWindow[]).find((w) => w === window) ?? DEFAULT_WINDOW,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ROWS) : PAGE_SIZE,
  };
}

/** The URL of a page of the feed with some filters changed: defaults are left out, and changing a filter starts again at the first page. */
export function filterHref(filter: ActivityFilter, change: Partial<ActivityFilter> = {}): string {
  const f = { ...filter, ...("limit" in change ? {} : { limit: PAGE_SIZE }), ...change };
  const q = new URLSearchParams();
  if (f.kind) q.set("kind", f.kind);
  if (f.server) q.set("server", f.server);
  if (f.project) q.set("project", f.project);
  if (f.app) q.set("app", f.app);
  if (f.failed) q.set("failed", "1");
  if (f.window !== DEFAULT_WINDOW) q.set("window", f.window);
  if (f.limit !== PAGE_SIZE) q.set("limit", String(f.limit));
  const text = q.toString();
  return text === "" ? "/activity" : `/activity?${text}`;
}

export interface FeedUnanswered {
  id: string;
  name: string;
  reason: string;
}

export interface FeedOptions {
  servers: ActivityServer[];
  projects: string[];
  apps: string[];
}

export interface Feed {
  /** The page, newest first. */
  events: ActivityEvent[];
  /** How many match the filter in all (before the page's limit). */
  total: number;
  /** More rows match than are shown, and the page may still ask for more. */
  more: boolean;
  /** The most the page shows has been reached: older rows are beyond it. */
  capped: boolean;
  /** Servers that did not answer: they are rows of the feed, not a silent absence. */
  unanswered: FeedUnanswered[];
  /** Servers that answered without one of their sources. */
  gaps: { server: ActivityServer; source: string; reason: string }[];
  options: FeedOptions;
}

/** What the page offers to filter by: what exists, not what matches. */
function optionsOf(servers: ServerActivity[]): FeedOptions {
  const apps = new Set<string>();
  const projects = new Set<string>();
  for (const s of servers) {
    for (const [app, project] of Object.entries(s.projects)) {
      apps.add(app);
      projects.add(project);
    }
  }
  const sort = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
  return { servers: servers.map((s) => s.server), projects: sort(projects), apps: sort(apps) };
}

export interface FeedInput {
  servers: ServerActivity[];
  dashboard: DashboardAuditEntry[];
  now: number;
  filter: ActivityFilter;
  /** Words for a deployment's or a run's trigger. */
  trigger: (code: string) => string;
}

/** Merges everything, newest first, and applies the filter. */
export function buildFeed({ servers, dashboard, now, filter, trigger }: FeedInput): Feed {
  const events: ActivityEvent[] = [];
  for (const s of servers) {
    if (s.unreachable !== undefined) continue;
    const started = new Map<string, { event: ActivityEvent; subject: string; type: "deployment" | "run" }>();
    for (const d of s.deployments) {
      const event = deploymentEvent(s, d, trigger);
      started.set(event.id, { event, subject: d.app, type: "deployment" });
      events.push(event);
    }
    for (const r of s.runs) {
      const event = runEvent(s, r, trigger);
      started.set(event.id, { event, subject: r.job, type: "run" });
      events.push(event);
    }
    for (const a of s.alerts ?? []) events.push(alertEvent(s, a));
    // Newest first, so the closest match of a pair is not taken by an older entry.
    const rest = attachActors(started, [...s.audit].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    for (const entry of rest) events.push(agentAuditEvent(s, entry));
  }
  for (const entry of dashboard) {
    const event = dashboardAuditEvent(entry);
    if (event) events.push(event);
  }

  const since = now - WINDOWS[filter.window];
  const matching = events
    .filter((e) => {
      if (Date.parse(e.at) < since) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.failed && !e.failed) return false;
      // The dashboard's own events belong to no server, app or project: choosing one leaves them out.
      if (filter.server !== undefined && e.server?.id !== filter.server) return false;
      if (filter.app !== undefined && e.app !== filter.app) return false;
      if (filter.project !== undefined && e.project !== filter.project) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));

  const limit = Math.min(Math.max(filter.limit, 1), MAX_ROWS);
  return {
    events: matching.slice(0, limit),
    total: matching.length,
    more: matching.length > limit && limit < MAX_ROWS,
    capped: matching.length > limit && limit >= MAX_ROWS,
    unanswered: servers
      .filter((s) => s.unreachable !== undefined && (filter.server === undefined || filter.server === s.server.id))
      .map((s) => ({ ...s.server, reason: s.unreachable as string })),
    gaps: servers.filter((s) => s.unreachable === undefined && (filter.server === undefined || filter.server === s.server.id)).flatMap((s) => s.gaps.map((g) => ({ server: s.server, ...g }))),
    options: optionsOf(servers),
  };
}
