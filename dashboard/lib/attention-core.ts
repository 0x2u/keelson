import type { AgentInfo, AlertRecord, AppStatus, Container, DatabaseStatus, Deployment, JobStatus, ProxyView, SystemInfo } from "@/lib/agent-types";
import { imageVersion } from "@/lib/image-ref-core";
import { deployEnding, deployNoun } from "@/lib/labels-core";
import { isDownManaged, isSick, signals } from "@/lib/health-core";
import { schedulePeriodMs } from "@/lib/schedule-period";
import type { Loaded } from "@/lib/data";
import type { Tone } from "@/lib/status";

// The one answer to "is everything fine, and if not, what and where": every rule that can say something is wrong, applied
// to the data loaded from the fleet. The home page, the server page's verdict and the sidebar's dots all read this list,
// so they cannot disagree. Pure: pages load the data, this decides.

export type Severity = "critical" | "warning" | "info";

export type AttentionKind =
  | "unreachable"
  | "engine"
  | "disk"
  | "memory"
  | "load"
  | "app-down"
  | "container"
  | "deployment"
  | "job"
  | "backup"
  | "proxy"
  | "alert";

export interface AttentionAction {
  label: string;
  href: string;
}

export interface AttentionItem {
  /** Stable across refreshes: server, kind and subject. */
  id: string;
  severity: Severity;
  kind: AttentionKind;
  server: { id: string; name: string };
  /** The app, job, database or container the item is about; empty for the server itself. */
  subject: string;
  /** What is wrong, with the cause when the agent gave one. */
  message: string;
  /** When it started (ISO), or null when the agent does not say. */
  since: string | null;
  actions: AttentionAction[];
}

/** What one server answered. A part the agent does not offer (a read-only agent has no apps) is null; one that failed is undefined. */
export interface ServerSnapshot {
  server: { id: string; name: string };
  reachable: boolean;
  /** Why it did not answer. */
  reason?: string;
  /** When it last answered this dashboard (ms), or null if never. */
  lastSeen: number | null;
  system?: SystemInfo | null;
  containers?: Container[];
  apps?: AppStatus[] | null;
  jobs?: JobStatus[] | null;
  databases?: DatabaseStatus[] | null;
  proxy?: ProxyView | null;
  /** The notifications the agent raised, newest first: null for an agent that keeps none, undefined when the page did not ask (no rule applies). */
  alerts?: AlertRecord[] | null;
  /** The parts (system, containers, apps, jobs, databases, proxy) that failed although the agent answered, with why: what they would have said is unknown, not fine. */
  errors?: Record<string, string>;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 2, warning: 1, info: 0 };

/** "40 s", "12 min", "3 h", "2 d": one unit, for how long something has been so. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** The first line of an error or output, short enough for one row. */
export function firstLine(text: string | undefined, max = 200): string {
  const line = (text ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const withCause = (what: string, cause: string | undefined): string => {
  const line = firstLine(cause);
  return line ? `${what}: ${line}` : what;
};

const stripSlash = (name: string): string => name.replace(/^\//, "");
const enc = encodeURIComponent;

const containerHref = (serverId: string, name: string): string => `/servers/${serverId}/containers/${enc(stripSlash(name))}`;
const appHref = (serverId: string, app: string): string => `/servers/${serverId}/apps/${enc(app)}`;

function sinceOf(...times: (string | undefined | null)[]): string | null {
  for (const t of times) if (t && !t.startsWith("0001-")) return t;
  return null;
}

function unreachableItem(s: ServerSnapshot, now: number): AttentionItem {
  const how = s.reason ? ` (${s.reason})` : "";
  const message =
    s.lastSeen === null
      ? `${s.server.name} did not answer${how}; this dashboard has never had an answer from it`
      : `${s.server.name} did not answer${how}; last answered ${spanText(now - s.lastSeen)} ago`;
  return {
    id: `${s.server.id}:unreachable`,
    severity: "warning",
    kind: "unreachable",
    server: s.server,
    subject: "",
    message,
    since: s.lastSeen === null ? null : new Date(s.lastSeen).toISOString(),
    actions: [
      { label: "Server", href: `/servers/${s.server.id}` },
      { label: "Settings", href: `/servers/${s.server.id}/settings` },
    ],
  };
}

const FAILED = new Set(["failed", "rolled_back", "rollback_failed"]);

function appItems(s: ServerSnapshot, covered: Set<string>): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const app of s.apps ?? []) {
    const c = app.container;
    const last = app.last_deployment;
    const base = { server: s.server, subject: app.name, id: `${s.server.id}:app:${app.name}`, kind: "app-down" as const };
    const deployment: AttentionAction[] = last ? [{ label: "Deployment", href: `/servers/${s.server.id}/deployments/${last.id}` }] : [];

    if (c) {
      covered.add(stripSlash(c.name));
      const logs: AttentionAction = { label: "Logs", href: containerHref(s.server.id, c.name) };
      const rollback: AttentionAction[] =
        last?.status === "succeeded" && last.previous_ref
          ? [{ label: `Roll back to ${imageVersion(last.previous_ref).version}`, href: appHref(s.server.id, app.name) }]
          : [];
      const actions = [logs, ...deployment, ...rollback];
      if (c.state.restarting) {
        out.push({ ...base, severity: "critical", message: `${app.name} keeps restarting (exit code ${c.state.exit_code})`, since: sinceOf(c.state.finished_at, c.state.started_at), actions });
      } else if (!c.state.running) {
        const why = c.state.oom_killed ? "killed: out of memory" : `exit code ${c.state.exit_code}`;
        out.push({ ...base, severity: "critical", message: `${app.name} is stopped (${why})`, since: sinceOf(c.state.finished_at), actions });
      } else if (c.state.health === "unhealthy") {
        out.push({ ...base, severity: "critical", message: `${app.name} is unhealthy: its health check fails`, since: sinceOf(c.state.started_at), actions });
      }
    } else if (!last) {
      out.push({ ...base, severity: "info", message: `${app.name} is configured but has never been deployed`, since: null, actions: [{ label: "App", href: appHref(s.server.id, app.name) }] });
    } else if (last.status === "succeeded") {
      out.push({ ...base, severity: "critical", message: `${app.name} has no container although its last deployment succeeded`, since: sinceOf(last.finished_at, last.started_at), actions: deployment });
    }

    if (last) out.push(...deploymentItem(s, app, last));
  }
  return out;
}

function deploymentItem(s: ServerSnapshot, app: AppStatus, d: Deployment): AttentionItem[] {
  if (!FAILED.has(d.status)) return [];
  const version = imageVersion(d.ref).version;
  const what = `${deployNoun(d.trigger)} of ${app.name} ${version} ${deployEnding(d.trigger, d.status)}`;
  const actions: AttentionAction[] = [{ label: "Deployment", href: `/servers/${s.server.id}/deployments/${d.id}` }];
  if (app.container) actions.push({ label: "Logs", href: containerHref(s.server.id, app.container.name) });
  return [
    {
      id: `${s.server.id}:deployment:${app.name}`,
      severity: d.status === "rollback_failed" ? "critical" : "warning",
      kind: "deployment",
      server: s.server,
      subject: app.name,
      message: withCause(what, d.error),
      since: sinceOf(d.finished_at, d.started_at),
      actions,
    },
  ];
}

function containerItems(s: ServerSnapshot, covered: Set<string>): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of s.containers ?? []) {
    const name = stripSlash(c.name);
    if (covered.has(name) || !(isSick(c) || isDownManaged(c))) continue;
    out.push({
      id: `${s.server.id}:container:${name}`,
      severity: "critical",
      kind: "container",
      server: s.server,
      subject: name,
      message: isSick(c) ? `Container ${name} is ${c.state === "restarting" ? "restarting" : "unhealthy"}` : `Container ${name} is ${c.state}`,
      since: null,
      actions: [{ label: "Logs", href: containerHref(s.server.id, name) }],
    });
  }
  return out;
}

function jobItems(s: ServerSnapshot): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const job of s.jobs ?? []) {
    // A database's backup is judged with the database, where its page and its cause are.
    const run = job.last_run;
    if (job.kind === "backup" || run?.status !== "failed") continue;
    out.push({
      id: `${s.server.id}:job:${job.name}`,
      severity: "warning",
      kind: "job",
      server: s.server,
      subject: job.name,
      message: withCause(`Job ${job.name} failed`, run.detail || run.output),
      since: sinceOf(run.finished_at, run.started_at),
      actions: [{ label: "Job output", href: `/servers/${s.server.id}/jobs/${enc(job.name)}` }],
    });
  }
  return out;
}

/** A backup is overdue when its last run began more than this many schedule periods ago. */
export const OVERDUE_PERIODS = 2;

function databaseItems(s: ServerSnapshot, now: number): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const db of s.databases ?? []) {
    const b = db.backup;
    if (!b || b.paused) continue;
    const base = {
      server: s.server,
      subject: db.name,
      id: `${s.server.id}:backup:${db.name}`,
      kind: "backup" as const,
      actions: [{ label: "Database", href: `/servers/${s.server.id}/databases/${enc(db.name)}` }],
    };
    const run = b.last_run;
    if (run?.status === "failed") {
      out.push({ ...base, severity: "critical", message: withCause(`Last backup of ${db.name} failed`, run.detail), since: sinceOf(run.finished_at, run.started_at) });
      continue;
    }
    if (!run) {
      // A first backup that is scheduled is just waiting (the Databases tab says "pending", not a problem); none scheduled is.
      if (!b.next_run) out.push({ ...base, severity: "warning", message: `${db.name} has no backup yet and none is scheduled`, since: null });
      continue;
    }
    if (run.status === "running") continue;
    const period = schedulePeriodMs(b.schedule);
    const lastAt = Date.parse(run.started_at);
    if (period !== null && Number.isFinite(lastAt) && now - lastAt > OVERDUE_PERIODS * period) {
      out.push({
        ...base,
        severity: "warning",
        message: `Last backup of ${db.name} was ${spanText(now - lastAt)} ago, more than ${OVERDUE_PERIODS} schedule periods (${b.schedule})`,
        since: new Date(lastAt + OVERDUE_PERIODS * period).toISOString(),
      });
    }
  }
  return out;
}

function proxyItems(s: ServerSnapshot): AttentionItem[] {
  const p = s.proxy;
  if (!p) return [];
  const base = { server: s.server, subject: "proxy", id: `${s.server.id}:proxy`, kind: "proxy" as const, since: null, actions: [{ label: "Proxy", href: `/servers/${s.server.id}/proxy` }] };
  if (p.live_error) return [{ ...base, severity: "warning", message: withCause("The proxy could not be read", p.live_error) }];
  if (p.in_sync === false) return [{ ...base, severity: "warning", message: `The ${p.type} configuration in use differs from what the agent generates` }];
  return [];
}

function unreadItems(s: ServerSnapshot): AttentionItem[] {
  const parts = Object.entries(s.errors ?? {}).filter(([part]) => part !== "deployments");
  if (parts.length === 0) return [];
  return [
    {
      id: `${s.server.id}:unread`,
      severity: "warning",
      kind: "unreachable",
      server: s.server,
      subject: "",
      message: `Can't tell about ${parts.map(([part]) => part).join(", ")} on ${s.server.name} (${firstLine(parts[0][1])})`,
      since: null,
      actions: [{ label: "Server", href: `/servers/${s.server.id}` }],
    },
  ];
}

/** A notification that did not reach every channel counts for this long: after a day the next alert will say if it still does. */
export const ALERT_DELIVERY_WINDOW_MS = 24 * 3600_000;

/** Whether the most recent notification of a server was lost, wholly or in part, within the last day: nobody may have heard about what it said. */
function alertItems(s: ServerSnapshot, now: number): AttentionItem[] {
  let last: AlertRecord | undefined;
  for (const a of s.alerts ?? []) if (!last || Date.parse(a.time) > Date.parse(last.time)) last = a;
  if (!last || (last.status !== "failed" && last.status !== "partial")) return [];
  const at = Date.parse(last.time);
  if (!Number.isFinite(at) || now - at > ALERT_DELIVERY_WINDOW_MS) return [];
  const channels = last.failed_channels?.length ? ` on ${last.failed_channels.join(", ")}` : "";
  const how = last.status === "failed" ? "reached no channel" : `did not reach every channel (failed${channels})`;
  return [
    {
      id: `${s.server.id}:alert`,
      severity: "warning",
      kind: "alert",
      server: s.server,
      subject: "",
      message: `The last alert of ${s.server.name} ${how}: ${firstLine(last.title, 120)}`,
      since: last.time,
      actions: [
        { label: "Notifications", href: `/servers/${encodeURIComponent(s.server.id)}/config/notifications` },
        { label: "Alerts", href: `/activity?kind=alert&server=${encodeURIComponent(s.server.id)}` },
      ],
    },
  ];
}

function hostItems(s: ServerSnapshot): AttentionItem[] {
  if (!s.system) return [];
  // Containers are judged one by one (with their app), not as a count.
  return signals(s.system, undefined).map((sig) => ({
    id: `${s.server.id}:${sig.kind}`,
    severity: sig.tone === "danger" ? ("critical" as const) : ("warning" as const),
    kind: sig.kind as "engine" | "disk" | "memory" | "load",
    server: s.server,
    subject: "",
    message: sig.text,
    since: null,
    actions: [{ label: "Server", href: `/servers/${s.server.id}` }],
  }));
}

/** Newest first: what just broke matters most among equals; items without a time come last. */
function compare(a: AttentionItem, b: AttentionItem): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  const ta = a.since ? Date.parse(a.since) : -Infinity;
  const tb = b.since ? Date.parse(b.since) : -Infinity;
  if (ta !== tb) return ta > tb ? -1 : 1;
  return a.server.name.localeCompare(b.server.name) || a.subject.localeCompare(b.subject) || a.kind.localeCompare(b.kind);
}

/** Everything that needs a look across the fleet, most urgent first. Empty means all good. */
export function attentionItems(snapshots: ServerSnapshot[], now: number = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of snapshots) {
    if (!s.reachable) {
      items.push(unreachableItem(s, now));
      continue;
    }
    const covered = new Set<string>();
    items.push(...unreadItems(s), ...hostItems(s), ...appItems(s, covered), ...containerItems(s, covered), ...jobItems(s), ...databaseItems(s, now), ...proxyItems(s), ...alertItems(s, now));
  }
  return items.sort(compare);
}

export interface Summary {
  /** The colour of the dot and badge. */
  tone: Tone;
  label: string;
  /** Items that need a look. */
  count: number;
}

/** The verdict for the given items (those of one server, or all). Never "fine" while there is an item. */
export function summarize(items: AttentionItem[]): Summary {
  if (items.length === 0) return { tone: "success", label: "Everything is fine", count: 0 };
  const worst = items.reduce<Severity>((w, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w), "info");
  const label = items.length === 1 ? "1 thing needs attention" : `${items.length} things need attention`;
  return { tone: worst === "critical" ? "danger" : worst === "warning" ? "warning" : "info", label, count: items.length };
}

export const itemsOf = (items: AttentionItem[], serverId: string): AttentionItem[] => items.filter((i) => i.server.id === serverId);

/** What stands where a server that did not answer would have shown its data: never an empty list, which would claim there is none. */
export function cantTell(servers: { name: string; reason?: string }[]): string {
  const names = servers.map((s) => s.name).join(", ");
  const reasons = [...new Set(servers.map((s) => s.reason).filter(Boolean))].join("; ");
  return `Can't tell: ${names} did not answer${reasons ? ` (${reasons})` : ""}`;
}

/** What each call to one server returned (see `load`); the server page and the fleet loader both build a snapshot from it. */
export interface ServerAnswers {
  info: Loaded<AgentInfo>;
  system: Loaded<SystemInfo | null>;
  containers: Loaded<Container[]>;
  apps: Loaded<AppStatus[] | null>;
  jobs: Loaded<JobStatus[] | null>;
  databases: Loaded<DatabaseStatus[] | null>;
  proxy: Loaded<ProxyView | null>;
}

/**
 * The snapshot of a server from its answers: unreachable when `info` failed (with that error as the reason), and when the
 * agent answered but a part failed, that part is listed in `errors` (it is unknown, not fine).
 */
export function snapshotFrom(server: { id: string; name: string }, a: ServerAnswers, lastSeen: number | null): ServerSnapshot {
  if (a.info.error !== undefined) return { server, reachable: false, reason: a.info.error, lastSeen };
  const errors: Record<string, string> = {};
  for (const part of ["system", "containers", "apps", "jobs", "databases", "proxy"] as const) {
    const r = a[part];
    if (r.error !== undefined) errors[part] = r.error;
  }
  return {
    server,
    reachable: true,
    lastSeen,
    system: a.system.data,
    containers: a.containers.data,
    apps: a.apps.data,
    jobs: a.jobs.data,
    databases: a.databases.data,
    proxy: a.proxy.data,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
