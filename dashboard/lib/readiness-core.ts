import type { AppStatus, ConfigDocument, ConfigModel, DatabaseBackupConfig, DatabaseStatus, Deployment, Proof, RestoreTest } from "@/lib/agent-types";
import { agentUpdate } from "@/lib/agent-binaries-core";
import { firstLine, spanText } from "@/lib/attention-core";
import type { Loaded } from "@/lib/data";
import { databaseRows, type BackupState } from "@/lib/databases-fleet-core";
import { versionOf } from "@/lib/image-ref-core";
import { projectPlacements, type ProjectMembers } from "@/lib/project-hub-core";
import type { Project } from "@/lib/projects-core";
import { notificationsHref } from "@/lib/redirects-core";
import { rollbackPlan } from "@/lib/rollback-core";
import { securityStatus } from "@/lib/settings-core";

// The readiness checklist: what separates "it runs" from "I can trust it". Every item is computed from facts the agent
// already holds (its configuration, its databases, the proofs it records) and from the dashboard's own state; nothing is
// stored here. It is a model of its own, not part of the attention model: a missing restore test is not an incident, so it
// never becomes an AttentionItem and never moves the "needs attention" verdict. Pure: the loaders (lib/readiness.ts) fetch,
// this decides.

export type ReadinessState = "ok" | "warning" | "critical" | "todo" | "na";

/** What an item is about: one database or app of a server, a server itself, or this dashboard. */
export type ReadinessScope = "project" | "server" | "dashboard";

export type ReadinessGroup = "data" | "alerts" | "deploys" | "access";

export type ReadinessCheck = "backup" | "restore" | "offsite" | "key" | "alert" | "health" | "rollback" | "versions" | "second-factor" | "dashboard-backup" | "reachable";

/** The actions that run from the item itself (a dialog or a button) instead of opening a page. */
export type ReadinessFix = "test-restore" | "prove-key" | "test-alert";

export interface ReadinessItem {
  /** Stable across refreshes. */
  id: string;
  scope: ReadinessScope;
  group: ReadinessGroup;
  check: ReadinessCheck;
  /** The database or app it is about, the server's name for a server's own, empty for the dashboard. */
  subject: string;
  /** The server it is about; absent for the dashboard. */
  server?: { id: string; name: string };
  /** The project the database or app belongs to, when it was told (see `forProject`). */
  project?: string;
  state: ReadinessState;
  /** What is checked: the same words in every place. */
  title: string;
  /** Where it stands, and why. */
  detail: string;
  /** When it was last proven or last happened (ISO), when there is such a time. */
  since?: string;
  /** The page that fixes it; absent when there is nothing to do. */
  action?: { label: string; href: string };
  /** The item can be fixed from where it is shown: the button that runs it replaces the link. */
  fix?: ReadinessFix;
}

// ---- Thresholds -------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * How long a proof stays fresh. Backups change every day and so does the key's custody (a rotated or lost key makes every
 * newer backup unreadable), so a restore test and a key proof older than 90 days say little about today's backups; an
 * alert test goes stale faster (webhooks are revoked, bots removed, chats muted); so does the dashboard's own backup
 * (its credentials change whenever a server is added). A backup that is overdue is the attention model's rule
 * (OVERDUE_PERIODS of its schedule), not a threshold of this file.
 */
export const STALE_AFTER_DAYS = { restore: 90, key: 90, alert: 30, dashboardBackup: 30 } as const;

// ---- What the checklist reads -----------------------------------------------------------------------------------------

/** What one call to an agent answered: its value, nothing because the agent is older than the route, or why it failed. */
export type Answer<T> = { kind: "ok"; value: T } | { kind: "old" } | { kind: "failed"; reason: string };

/** A call that returns null for an agent without the route (see `AgentClient`): null is "old", an error is "failed". */
export function answerOf<T>(loaded: Loaded<T | null>): Answer<T> {
  if (loaded.error !== undefined) return { kind: "failed", reason: loaded.error };
  return loaded.data === null ? { kind: "old" } : { kind: "ok", value: loaded.data };
}

/** The configuration: `ok` with null is an agent with no apps file (read-only), which has nothing to configure. */
export type ConfigAnswer = Exclude<Answer<ConfigModel | null>, { kind: "old" }>;

export function configAnswer(loaded: Loaded<ConfigDocument | null>): ConfigAnswer {
  if (loaded.error !== undefined) return { kind: "failed", reason: loaded.error };
  if (loaded.data === null) return { kind: "ok", value: null };
  if (loaded.data.error) return { kind: "failed", reason: "its configuration file is invalid" };
  return { kind: "ok", value: loaded.data.model };
}

export interface ServerReadinessInput {
  server: { id: string; name: string };
  reachable: boolean;
  /** Why it did not answer. */
  reason?: string;
  /** The agent's version. */
  version?: string;
  /** The agent this dashboard carries; null when it carries none. */
  bundledVersion: string | null;
  /** null: the agent has no apps file; undefined: the part failed (see `errors`). */
  apps?: AppStatus[] | null;
  databases?: DatabaseStatus[] | null;
  /** The parts (`apps`, `databases`) that failed although the agent answered: unknown, not fine. */
  errors?: Record<string, string>;
  config: ConfigAnswer;
  proofs: Answer<Proof[]>;
  /** The restore tests of each database, by its name. */
  restoreTests: Record<string, Answer<RestoreTest[]>>;
  /** The deployments of each app, by its name (the window `rollbackPlan` looks through). */
  histories: Record<string, Answer<Deployment[]>>;
}

export interface DashboardReadinessInput {
  totp: boolean;
  passkeys: number;
  /** When a copy of the dashboard's state was last downloaded (ms), or null when none ever was. */
  lastBackupAt: number | null;
}

// ---- Items ------------------------------------------------------------------------------------------------------------

const enc = encodeURIComponent;
const dbHref = (serverId: string, db: string): string => `/servers/${serverId}/config/databases/${enc(db)}`;
const updateHref = (serverId: string): string => `/servers/${serverId}/update`;

const TITLES: Record<ReadinessCheck, string> = {
  backup: "Backups configured",
  restore: "Restore tested",
  offsite: "Off-site copy",
  key: "Encryption key proven",
  alert: "Alert channel tested",
  health: "Health check present",
  rollback: "Rollback target exists",
  versions: "Agent and dashboard versions match",
  "second-factor": "Second factor on the dashboard",
  "dashboard-backup": "Dashboard's own state backed up",
  reachable: "Server answers",
};

const GROUPS: Record<ReadinessCheck, ReadinessGroup> = {
  backup: "data",
  restore: "data",
  offsite: "data",
  key: "data",
  "dashboard-backup": "data",
  alert: "alerts",
  health: "deploys",
  rollback: "deploys",
  versions: "deploys",
  "second-factor": "access",
  reachable: "access",
};

/** The groups in the order they are shown, with their headings. */
export const READINESS_GROUPS: { id: ReadinessGroup; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "alerts", label: "Alerts" },
  { id: "deploys", label: "Deploys" },
  { id: "access", label: "Access" },
];

function item(check: ReadinessCheck, scope: ReadinessScope, subject: string, server: { id: string; name: string } | undefined, rest: Pick<ReadinessItem, "state" | "detail"> & Partial<Pick<ReadinessItem, "since" | "action" | "fix">>): ReadinessItem {
  const id = scope === "dashboard" ? `dashboard:${check}` : `${server?.id}:${check}:${subject}`;
  return { id, scope, group: GROUPS[check], check, subject, ...(server ? { server } : {}), title: TITLES[check], ...rest };
}

const ago = (at: string, now: number): string => `${spanText(now - Date.parse(at))} ago`;

/** The newest proof of a kind and subject. */
function proofOf(proofs: Proof[], kind: Proof["kind"], subject: string): Proof | undefined {
  return proofs.filter((p) => p.kind === kind && p.subject === subject).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

const isStale = (at: string | number, now: number, days: number): boolean => now - (typeof at === "number" ? at : Date.parse(at)) > days * DAY_MS;

/** The answer to a proof-based check that cannot be had: the agent is too old for the routes, or did not answer. */
function unknownProofs(check: ReadinessCheck, scope: ReadinessScope, subject: string, server: { id: string; name: string }, a: Exclude<Answer<unknown>, { kind: "ok" }>): ReadinessItem {
  if (a.kind === "old") {
    return item(check, scope, subject, server, { state: "todo", detail: `The agent on ${server.name} is too old for this check. Update it first.`, action: { label: "Update the agent", href: updateHref(server.id) } });
  }
  return item(check, scope, subject, server, { state: "todo", detail: `Can't tell: ${a.reason}` });
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

/** The S3 endpoints a backup writes to that are not on the machine itself; the places that survive losing the server. */
function remoteDestinations(backup: DatabaseBackupConfig): string[] {
  const out: string[] = [];
  for (const p of backup.destinations) {
    if (!p.s3) continue;
    let host = "";
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(p.s3.endpoint) ? p.s3.endpoint : `https://${p.s3.endpoint}`).hostname;
    } catch {
      continue;
    }
    if (host !== "" && !isLoopback(host)) out.push(`${host}/${p.s3.bucket}`);
  }
  return out;
}

const BACKUP_VIEW: Record<BackupState, { state: ReadinessState; detail: (ago: string | null) => string }> = {
  failed: { state: "critical", detail: () => "The last backup failed." },
  overdue: { state: "warning", detail: () => "The last backup is overdue." },
  "never-scheduled": { state: "warning", detail: () => "No backup has been made and none is scheduled." },
  "not-configured": { state: "todo", detail: () => "No backup is configured for this database." },
  paused: { state: "warning", detail: () => "Backups are paused." },
  "first-pending": { state: "todo", detail: () => "The first backup is scheduled and has not run yet." },
  running: { state: "ok", detail: () => "A backup is running now." },
  ok: { state: "ok", detail: (t) => (t ? `The last backup finished ${t}.` : "Backups are running on schedule.") },
};

function databaseItems(input: ServerReadinessInput, now: number): ReadinessItem[] {
  const { server } = input;
  const databases = input.databases ?? [];
  if (databases.length === 0) return [];
  const rows = new Map(
    databaseRows([{ server, reachable: true, lastSeen: now, databases }], now).rows.map((r) => [r.database.name, r]),
  );
  const config = input.config.kind === "ok" ? input.config.value : null;
  const out: ReadinessItem[] = [];
  for (const db of databases) {
    const row = rows.get(db.name);
    const state = row?.state ?? "not-configured";
    const configured = state !== "not-configured";
    const configure = { label: "Configure backups", href: dbHref(server.id, db.name) };
    const dbPage = { label: "Open the database", href: `/servers/${server.id}/databases/${enc(db.name)}` };

    // Backups configured: the existing rules (failed, overdue, never scheduled, paused), with the attention model's sentence for the cause.
    const view = BACKUP_VIEW[state];
    const lastRun = db.backup?.last_run;
    const backupDetail = row?.detail ?? view.detail(lastRun && state === "ok" ? ago(lastRun.started_at, now) : null);
    out.push(item("backup", "project", db.name, server, { state: view.state, detail: backupDetail, ...(lastRun ? { since: lastRun.started_at } : {}), ...(view.state === "ok" ? {} : { action: state === "not-configured" ? configure : dbPage }) }));

    out.push(restoreItem(input, db, configured, now));
    out.push(offsiteItem(input, db, config, configure));
    out.push(keyItem(input, db, configured, now));
  }
  return out;
}

function needsBackup(check: ReadinessCheck, db: DatabaseStatus, server: { id: string; name: string }): ReadinessItem {
  return item(check, "project", db.name, server, { state: "todo", detail: "There is no backup to check yet: configure one first.", action: { label: "Configure backups", href: dbHref(server.id, db.name) } });
}

function restoreItem(input: ServerReadinessInput, db: DatabaseStatus, configured: boolean, now: number): ReadinessItem {
  const { server } = input;
  if (!configured) return needsBackup("restore", db, server);
  if (input.proofs.kind !== "ok") return unknownProofs("restore", "project", db.name, server, input.proofs);
  const proof = proofOf(input.proofs.value, "restore", db.name);
  const answered = input.restoreTests[db.name];
  const latest = answered?.kind === "ok" ? answered.value[0] : undefined;
  const fix = { fix: "test-restore" as const, action: { label: "Test restore", href: `/servers/${server.id}/databases/${enc(db.name)}` } };
  if (latest?.status === "failed" && (!proof || Date.parse(latest.started_at) > Date.parse(proof.at))) {
    const why = firstLine(latest.error);
    return item("restore", "project", db.name, server, { state: "critical", detail: `The last test, ${ago(latest.started_at, now)}, failed${why ? `: ${why}` : ""}.`, since: latest.started_at, ...fix });
  }
  if (proof) {
    const stale = isStale(proof.at, now, STALE_AFTER_DAYS.restore);
    return item("restore", "project", db.name, server, {
      state: stale ? "warning" : "ok",
      detail: stale ? `Last tested ${ago(proof.at, now)}: a test older than ${STALE_AFTER_DAYS.restore} days says little about today's backups.` : `A backup was restored into a scratch database ${ago(proof.at, now)}.`,
      since: proof.at,
      ...fix,
    });
  }
  if (latest?.status === "running") return item("restore", "project", db.name, server, { state: "todo", detail: "A test is running now.", since: latest.started_at, ...fix });
  return item("restore", "project", db.name, server, { state: "todo", detail: "No restore has been tested: until one has, nobody knows these backups can be restored.", ...fix });
}

function offsiteItem(input: ServerReadinessInput, db: DatabaseStatus, config: ConfigModel | null, configure: { label: string; href: string }): ReadinessItem {
  const { server } = input;
  if (!db.backup) return needsBackup("offsite", db, server);
  if (input.config.kind === "failed") return item("offsite", "project", db.name, server, { state: "todo", detail: `Can't tell where the backups go: ${input.config.reason}.` });
  const backup = config?.databases?.find((d) => d.name === db.name)?.backups;
  if (!backup) return item("offsite", "project", db.name, server, { state: "todo", detail: "Can't tell where the backups go: the agent's configuration does not list this database.", action: configure });
  const remote = remoteDestinations(backup);
  if (remote.length > 0) return item("offsite", "project", db.name, server, { state: "ok", detail: `A copy goes to ${remote.join(", ")}.` });
  return item("offsite", "project", db.name, server, {
    state: "todo",
    detail: "The backups stay on this server: losing the machine loses them too. Add an S3-compatible destination.",
    action: configure,
  });
}

function keyItem(input: ServerReadinessInput, db: DatabaseStatus, configured: boolean, now: number): ReadinessItem {
  const { server } = input;
  if (!configured) return needsBackup("key", db, server);
  if (input.proofs.kind !== "ok") return unknownProofs("key", "project", db.name, server, input.proofs);
  const proof = proofOf(input.proofs.value, "key", db.name);
  const fix = { fix: "prove-key" as const, action: { label: "Prove the key", href: `/servers/${server.id}/databases/${enc(db.name)}` } };
  if (!proof) {
    return item("key", "project", db.name, server, { state: "todo", detail: "Nobody has shown that a key still opens these backups. Paste it once: it is used for one request and never stored.", ...fix });
  }
  const stale = isStale(proof.at, now, STALE_AFTER_DAYS.key);
  return item("key", "project", db.name, server, {
    state: stale ? "warning" : "ok",
    detail: stale ? `Proven ${ago(proof.at, now)}: a proof older than ${STALE_AFTER_DAYS.key} days does not cover the newer backups.` : `A backup was decrypted with the key ${ago(proof.at, now)}.`,
    since: proof.at,
    ...fix,
  });
}

/** What the agent can run as a health check: a path of the app's own, the pages verified during the soak, or the image's HEALTHCHECK. */
function healthSource(app: AppStatus, config: ConfigModel | null): string | null {
  const configured = config?.apps?.find((a) => a.name === app.name);
  if (configured?.health_path) return `GET ${configured.health_path}`;
  if (configured?.verify && configured.verify.length > 0) return `GET ${configured.verify[0].path} during the soak`;
  if (app.container?.state.health !== undefined) return "the image's HEALTHCHECK";
  return null;
}

function appItems(input: ServerReadinessInput, now: number): ReadinessItem[] {
  const { server } = input;
  const config = input.config.kind === "ok" ? input.config.value : null;
  const out: ReadinessItem[] = [];
  for (const app of input.apps ?? []) {
    // A preview environment is not in the apps file: it is judged with the app whose template made it.
    if (config !== null && !config.apps?.some((a) => a.name === app.name)) continue;
    const appHref = `/servers/${server.id}/apps/${enc(app.name)}`;
    const source = healthSource(app, config);
    out.push(
      source !== null
        ? item("health", "project", app.name, server, { state: "ok", detail: `A new version is checked with ${source} before it takes traffic.` })
        : item("health", "project", app.name, server, {
            state: "todo",
            detail: "No health check: a deployment cannot tell a broken version from a working one. Set a health path or a HEALTHCHECK in the image.",
            action: { label: "Edit app", href: `/servers/${server.id}/config/apps/${enc(app.name)}` },
          }),
    );

    const history = input.histories[app.name];
    if (history === undefined || history.kind !== "ok") {
      out.push(item("rollback", "project", app.name, server, { state: "todo", detail: `Can't tell: ${history?.kind === "failed" ? history.reason : "the deployments were not read"}.`, action: { label: "Open the app", href: appHref } }));
      continue;
    }
    if (history.value.length === 0 && app.container === null) {
      out.push(item("rollback", "project", app.name, server, { state: "na", detail: "Not deployed yet: there is nothing to go back to." }));
      continue;
    }
    const plan = rollbackPlan(history.value, app.container?.image ?? "");
    out.push(
      plan.ok
        ? item("rollback", "project", app.name, server, { state: "ok", detail: `Roll back goes to ${versionOf(plan.target.ref)}, deployed ${ago(plan.target.started_at, now)}.` })
        : item("rollback", "project", app.name, server, { state: "todo", detail: plan.reason, action: { label: "Open the app", href: appHref } }),
    );
  }
  return out;
}

function alertItem(input: ServerReadinessInput, now: number): ReadinessItem[] {
  const { server } = input;
  if (input.config.kind === "failed") return [item("alert", "server", server.name, server, { state: "todo", detail: `Can't tell: ${input.config.reason}.` })];
  const model = input.config.value;
  if (model === null) return [item("alert", "server", server.name, server, { state: "na", detail: "This server is read-only: it has no notifications to send." })];
  const channels = [...(model.notifications?.webhooks?.length ? [`${model.notifications.webhooks.length === 1 ? "a webhook" : `${model.notifications.webhooks.length} webhooks`}`] : []), ...(model.notifications?.telegram ? ["Telegram"] : [])];
  if (channels.length === 0) {
    const heartbeat = model.notifications?.heartbeat ? " Only a heartbeat is set, and it cannot be tested." : "";
    return [
      item("alert", "server", server.name, server, {
        state: "todo",
        detail: `No alert channel: nothing tells you when an app goes down or a backup fails.${heartbeat}`,
        action: { label: "Set up alerts", href: notificationsHref(server.id) },
      }),
    ];
  }
  if (input.proofs.kind !== "ok") return [unknownProofs("alert", "server", server.name, server, input.proofs)];
  const proof = proofOf(input.proofs.value, "alert", "");
  const fix = { fix: "test-alert" as const, action: { label: "Send a test alert", href: notificationsHref(server.id) } };
  if (!proof) return [item("alert", "server", server.name, server, { state: "todo", detail: `${channels.join(" and ")} configured, never tested: a message has never been seen to arrive.`, ...fix })];
  const stale = isStale(proof.at, now, STALE_AFTER_DAYS.alert);
  return [
    item("alert", "server", server.name, server, {
      state: stale ? "warning" : "ok",
      detail: stale ? `Last tested ${ago(proof.at, now)}: a webhook can be revoked or a chat muted since.` : `A test message reached ${channels.join(" and ")} ${ago(proof.at, now)}.`,
      since: proof.at,
      ...fix,
    }),
  ];
}

function versionItem(input: ServerReadinessInput): ReadinessItem {
  const { server } = input;
  const state = agentUpdate(input.version ?? "", input.bundledVersion);
  if (state === "current") return item("versions", "server", server.name, server, { state: "ok", detail: `The agent runs ${input.version}, the version this dashboard carries.` });
  if (state === "older" || state === "different") {
    return item("versions", "server", server.name, server, {
      state: "warning",
      detail: `The agent runs ${input.version}; this dashboard carries ${input.bundledVersion}.`,
      action: { label: "Update the agent", href: updateHref(server.id) },
    });
  }
  if (state === "newer") {
    return item("versions", "server", server.name, server, { state: "warning", detail: `The agent runs ${input.version}, newer than the ${input.bundledVersion} this dashboard carries: update the dashboard first.` });
  }
  return item("versions", "server", server.name, server, { state: "na", detail: input.bundledVersion === null ? "This dashboard carries no agent to compare with." : "The agent did not say its version." });
}

/** What the checklist cannot read: the server did not answer, or one of its parts failed. */
function unknownItems(input: ServerReadinessInput): ReadinessItem[] {
  const { server } = input;
  if (!input.reachable) {
    return [item("reachable", "server", server.name, server, { state: "todo", detail: `Can't tell: ${server.name} did not answer${input.reason ? ` (${input.reason})` : ""}.`, action: { label: "Open the server", href: `/servers/${server.id}` } })];
  }
  return Object.entries(input.errors ?? {})
    .filter(([part]) => part === "apps" || part === "databases")
    .map(([part, reason]) => item("reachable", "server", part, server, { state: "todo", detail: `Can't tell: the ${part} of ${server.name} could not be read (${reason}).`, action: { label: "Open the server", href: `/servers/${server.id}` } }));
}

const STATE_ORDER: Record<ReadinessState, number> = { critical: 0, warning: 1, todo: 2, ok: 3, na: 4 };
const GROUP_ORDER: Record<ReadinessGroup, number> = { data: 0, alerts: 1, deploys: 2, access: 3 };

const byPlace = (a: ReadinessItem, b: ReadinessItem): number =>
  (a.server?.name ?? "").localeCompare(b.server?.name ?? "") || a.subject.localeCompare(b.subject) || a.check.localeCompare(b.check);

/** Groups in display order; inside a group the worst first, then by server, subject and check. */
export function sortItems(items: ReadinessItem[]): ReadinessItem[] {
  return [...items].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || STATE_ORDER[a.state] - STATE_ORDER[b.state] || byPlace(a, b));
}

/** Every item of one server: its databases and apps (scope "project", the project not yet known) and the server's own. */
export function serverReadiness(input: ServerReadinessInput, now: number): ReadinessItem[] {
  const unknown = unknownItems(input);
  if (!input.reachable) return unknown;
  return [...unknown, ...databaseItems(input, now), ...appItems(input, now), ...alertItem(input, now), versionItem(input)];
}

/** The second factor of the dashboard: an authenticator app or a passkey. */
export function secondFactorItem(totp: boolean, passkeys: number): ReadinessItem {
  const on = totp || passkeys > 0;
  return item("second-factor", "dashboard", "", undefined, {
    state: on ? "ok" : "todo",
    detail: on ? securityStatus(totp, passkeys).label : "Only a password protects this dashboard, and it can deploy to and read logs from every server.",
    ...(on ? {} : { action: { label: "Add a second factor", href: "/settings/security" } }),
  });
}

/** A copy of the dashboard's own state: never made, made but older than `STALE_AFTER_DAYS.dashboardBackup`, or fresh. */
export function dashboardBackupItem(lastBackupAt: number | null, now: number): ReadinessItem {
  if (lastBackupAt === null) {
    return item("dashboard-backup", "dashboard", "", undefined, {
      state: "todo",
      detail: "No copy of the dashboard's state has been downloaded: its servers, tokens and settings live in one file on one machine.",
      action: { label: "Download a copy", href: "/settings/backup" },
    });
  }
  const at = new Date(lastBackupAt).toISOString();
  const stale = isStale(lastBackupAt, now, STALE_AFTER_DAYS.dashboardBackup);
  return item("dashboard-backup", "dashboard", "", undefined, {
    state: stale ? "warning" : "ok",
    detail: stale ? `The last copy was downloaded ${ago(at, now)}: servers and tokens added since are not in it.` : `The last copy was downloaded ${ago(at, now)}.`,
    since: at,
    action: { label: stale ? "Download a copy" : "Open backup", href: "/settings/backup" },
  });
}

/** The dashboard's own items: the second factor, and a copy of its state. */
export function dashboardReadiness(input: DashboardReadinessInput, now: number): ReadinessItem[] {
  return [secondFactorItem(input.totp, input.passkeys), dashboardBackupItem(input.lastBackupAt, now)];
}

// ---- Which items belong where -----------------------------------------------------------------------------------------

/** What a project owns: the servers its apps run on, and its databases and apps by "<server id>/<name>" (see `ownedKey`). */
export interface ProjectOwnership {
  name: string;
  servers: string[];
  databases: Set<string>;
  apps: Set<string>;
}

export const ownedKey = (serverId: string, name: string): string => `${serverId}/${name}`;

/** The ownership of a project from what the hub derived: the members its Databases tab lists, and the apps of its environments. */
export function projectOwnership(project: Project, members: ProjectMembers): ProjectOwnership {
  const placements = projectPlacements(project);
  return {
    name: project.name,
    servers: [...new Set(placements.map((p) => p.server.id))],
    databases: new Set(members.databases.map((d) => ownedKey(d.server.id, d.db.name))),
    apps: new Set(placements.map((p) => ownedKey(p.server.id, p.app.name))),
  };
}

/** A database's or an app's item is the project's when the thing it is about is. */
function owns(own: ProjectOwnership, i: ReadinessItem): boolean {
  if (i.scope !== "project" || !i.server) return false;
  const key = ownedKey(i.server.id, i.subject);
  return i.check === "health" || i.check === "rollback" ? own.apps.has(key) : own.databases.has(key);
}

/** The items with the project named on those of a database or an app a project owns. */
export function assignProjects(items: ReadinessItem[], projects: ProjectOwnership[]): ReadinessItem[] {
  return items.map((i) => {
    const own = projects.find((p) => owns(p, i));
    return own ? { ...i, project: own.name } : i;
  });
}

/**
 * What a project's Readiness tab lists: its databases' and apps' items (with the project named), the items of the servers
 * it runs on, and the dashboard's. A project with no database says so, in one line, instead of showing no backup items.
 */
export function forProject(items: ReadinessItem[], own: ProjectOwnership): ReadinessItem[] {
  const mine = assignProjects(items, [own]).filter((i) => i.project === own.name || i.scope === "dashboard" || (i.scope === "server" && i.server !== undefined && own.servers.includes(i.server.id)));
  if (own.databases.size === 0) {
    mine.push({
      id: `project:${own.name}:no-database`,
      scope: "project",
      group: "data",
      check: "backup",
      subject: own.name,
      project: own.name,
      state: "na",
      title: "Backups, restore test, off-site copy and encryption key",
      detail: "This project has no database, so there is nothing to back up.",
    });
  }
  return sortItems(mine);
}

/** What a server's page lists: the items about the server itself. */
export const forServer = (items: ReadinessItem[], serverId: string): ReadinessItem[] => sortItems(items.filter((i) => i.scope === "server" && i.server?.id === serverId));

// ---- The verdict ------------------------------------------------------------------------------------------------------

export interface ReadinessSummary {
  /** Items that pass. */
  passing: number;
  /** Items that apply: the "not applicable" ones are not counted either way. */
  total: number;
  /** The first thing to do: the worst state, then the order of the groups (data first). */
  worst: ReadinessItem | null;
  /** "Trust: 7 of 12 checks pass". */
  text: string;
}

export function readinessSummary(items: ReadinessItem[]): ReadinessSummary {
  const applicable = items.filter((i) => i.state !== "na");
  const passing = applicable.filter((i) => i.state === "ok").length;
  const worst = applicable.filter((i) => i.state !== "ok").sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || byPlace(a, b))[0] ?? null;
  const text = applicable.length === 0 ? "Trust: no check applies yet" : `Trust: ${passing} of ${applicable.length} ${applicable.length === 1 ? "check passes" : "checks pass"}`;
  return { passing, total: applicable.length, worst, text };
}

/** The page where the worst item is dealt with: its project's tab, its server's page, or the dashboard's settings. */
export function readinessHref(i: ReadinessItem): string {
  if (i.scope === "dashboard") return i.check === "second-factor" ? "/settings/security" : "/settings/backup";
  if (i.scope === "server") return `/servers/${i.server?.id}`;
  if (i.project !== undefined) return `/projects/${enc(i.project)}/readiness`;
  return i.action?.href ?? `/servers/${i.server?.id}`;
}
