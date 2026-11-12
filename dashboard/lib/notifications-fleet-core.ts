import type { NotificationsConfig } from "@/lib/agent-types";
import {
  channelsOf,
  differences,
  eventsSummary,
  hasAlertChannel,
  mergeTemplate,
  NEW_URL_TEXT,
  sectionText,
  wouldChange,
  type Channels,
  type Difference,
  type NotificationsTemplate,
} from "@/lib/notifications-core";

// What the Notifications page lists: one row per server, built from what each agent reported. Pure; the page lays it out.
// A server that did not answer is a row that says so, never a row of blanks that looks like "nothing configured".

/** What reading one server's notification settings found. */
export type ConfigFact =
  | { kind: "ok"; hash: string; notifications?: NotificationsConfig }
  | { kind: "no-file" }
  | { kind: "invalid" }
  | { kind: "failed"; reason: string };

/** When the agent last saw a test alert reach a channel (GET /v1/proofs, kind alert). */
export type TestFact = { kind: "at"; at: string } | { kind: "never" } | { kind: "unknown" };

/** The proofs an agent keeps, reduced to the last alert test (null: the agent is older than the route). */
export function testFact(proofs: readonly { kind: string; at: string }[] | null): TestFact {
  if (proofs === null) return { kind: "unknown" };
  const latest = proofs.filter((p) => p.kind === "alert").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return latest ? { kind: "at", at: latest.at } : { kind: "never" };
}

export interface ServerFacts {
  id: string;
  name: string;
  /** The dashboard holds the deploy secret: changes can be signed. */
  canDeploy: boolean;
  config: ConfigFact;
  test: TestFact;
}

export const READ_ONLY_REASONS = {
  noSecret: "This server is read-only here: add its deploy access in the server settings to change it.",
  noFile: "This server has no configuration to write to: it is read-only.",
  invalid: "The configuration file is currently invalid.",
} as const;

export interface NotificationsRow {
  id: string;
  name: string;
  /** ok: its section can be changed from here. read-only: it can be read (maybe), not changed. unreachable: the agent did not answer. */
  state: "ok" | "read-only" | "unreachable";
  /** Why it is read-only or unreachable. */
  reason?: string;
  /** The hash of the file the section was read from: the base of a save. Present whenever the file was read. */
  hash?: string;
  /** The section as the agent reports it (secrets hidden); absent when the server has none, or was not read. */
  notifications?: NotificationsConfig;
  /** The file was read: `notifications`, `channels` and `differs` mean something. */
  read: boolean;
  channels?: Channels;
  events?: { text: string; list: string[] };
  /** The thresholds the file sets; absent when the agent's default applies. */
  disk?: number;
  memory?: number;
  /** How the section differs from the default; empty when it follows it or there is no default. */
  differs: Difference[];
  test: TestFact;
}

/** One row of a server, compared with the default (null: none set). */
export function notificationsRow(f: ServerFacts, template: NotificationsTemplate | null): NotificationsRow {
  const base = { id: f.id, name: f.name, test: f.test };
  if (f.config.kind === "failed") return { ...base, state: "unreachable", reason: f.config.reason, read: false, differs: [] };
  if (f.config.kind === "no-file") return { ...base, state: "read-only", reason: READ_ONLY_REASONS.noFile, read: false, differs: [] };
  if (f.config.kind === "invalid") return { ...base, state: "read-only", reason: READ_ONLY_REASONS.invalid, read: false, differs: [] };
  const n = f.config.notifications;
  return {
    ...base,
    state: f.canDeploy ? "ok" : "read-only",
    ...(f.canDeploy ? {} : { reason: READ_ONLY_REASONS.noSecret }),
    hash: f.config.hash,
    ...(n === undefined ? {} : { notifications: n }),
    read: true,
    channels: channelsOf(n),
    events: eventsSummary(n),
    ...(n?.disk_alert_percent === undefined ? {} : { disk: n.disk_alert_percent }),
    ...(n?.memory_alert_percent === undefined ? {} : { memory: n.memory_alert_percent }),
    differs: template === null ? [] : differences(template, n),
  };
}

// ---- Filters, search, order, pages ------------------------------------------------------------------------------------

export type Filter = "all" | "no-channel" | "differs" | "unreachable" | "read-only";

export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "no-channel", label: "No channel" },
  { id: "differs", label: "Differs" },
  { id: "unreachable", label: "Unreachable" },
  { id: "read-only", label: "Read-only" },
];

/** A server that was read and has nothing that can say an alert. */
export const noChannel = (r: NotificationsRow): boolean => r.read && r.channels !== undefined && !hasAlertChannel(r.channels);

const MATCHES: Record<Filter, (r: NotificationsRow) => boolean> = {
  all: () => true,
  "no-channel": noChannel,
  differs: (r) => r.differs.length > 0,
  unreachable: (r) => r.state === "unreachable",
  "read-only": (r) => r.state === "read-only",
};

export function countsByFilter(rows: readonly NotificationsRow[]): Record<Filter, number> {
  return Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter(MATCHES[f.id]).length])) as Record<Filter, number>;
}

/** The rows for a filter and a search (by name, or id, ignoring case), problems first, then by name. */
export function visibleRows(rows: readonly NotificationsRow[], filter: Filter, query: string): NotificationsRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(MATCHES[filter]).filter((r) => q === "" || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)).sort(compareRows);
}

/** Unreachable first (nothing is known), then no channel (an outage goes unheard), then differs, then read-only, then the rest. */
function rank(r: NotificationsRow): number {
  if (r.state === "unreachable") return 0;
  if (noChannel(r)) return 1;
  if (r.differs.length > 0) return 2;
  if (r.state === "read-only") return 3;
  return 4;
}

const compareRows = (a: NotificationsRow, b: NotificationsRow): number => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);

export const PAGE_SIZE = 25;

export interface Page<T> {
  items: T[];
  /** The page shown, 1-based, kept within the pages that exist. */
  page: number;
  pages: number;
  total: number;
  /** 1-based position of the first and last item on the page (0 when empty). */
  from: number;
  to: number;
}

export function paginate<T>(list: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  const items = list.slice(start, start + size);
  return { items, page: current, pages, total: list.length, from: items.length === 0 ? 0 : start + 1, to: start + items.length };
}

// ---- Selecting servers to apply the default to -------------------------------------------------------------------------

/** What can be applied to: a server that answered and can be changed. */
export const selectable = (r: NotificationsRow): boolean => r.state === "ok";

export const selectableIds = (rows: readonly NotificationsRow[]): string[] => rows.filter(selectable).map((r) => r.id);

export const differingIds = (rows: readonly NotificationsRow[]): string[] => rows.filter((r) => selectable(r) && r.differs.length > 0).map((r) => r.id);

// ---- The plan of an apply ----------------------------------------------------------------------------------------------

export type PlanItem =
  | { kind: "change"; id: string; name: string; changes: Difference[]; before: string; after: string }
  | { kind: "same"; id: string; name: string }
  | { kind: "blocked"; id: string; name: string; why: "unreachable" | "read-only" | "needs-url"; detail: string };

/**
 * What applying the template would do to each of these servers, for the dialog that asks first. `urlGiven[i]` says the
 * operator typed a URL for webhook slot i (the URL itself never gets here). The executor re-reads every server when it runs.
 */
export function planApply(template: NotificationsTemplate, rows: readonly NotificationsRow[], urlGiven: readonly boolean[]): PlanItem[] {
  const shownUrls = template.webhooks.map((_, i) => (urlGiven[i] ? NEW_URL_TEXT : ""));
  return rows.map((r): PlanItem => {
    const who = { id: r.id, name: r.name };
    if (r.state === "unreachable") return { kind: "blocked", ...who, why: "unreachable", detail: r.reason ?? "The agent did not answer." };
    if (r.state === "read-only") return { kind: "blocked", ...who, why: "read-only", detail: r.reason ?? "This server cannot be changed from here." };
    if (!wouldChange(template, r.notifications, shownUrls)) return { kind: "same", ...who };
    const merged = mergeTemplate(r.notifications, template, shownUrls);
    if (!merged.ok) return { kind: "blocked", ...who, why: "needs-url", detail: `It has no webhook ${merged.needsUrl}: enter its URL.` };
    // A URL typed for a server that already follows the default is the one change.
    const changes = differences(template, r.notifications);
    return { kind: "change", ...who, changes: changes.length > 0 ? changes : ["webhooks"], before: sectionText(r.notifications), after: sectionText(merged.config) };
  });
}

export function planCounts(plan: readonly PlanItem[]): { change: number; same: number; blocked: number } {
  return { change: plan.filter((p) => p.kind === "change").length, same: plan.filter((p) => p.kind === "same").length, blocked: plan.filter((p) => p.kind === "blocked").length };
}
