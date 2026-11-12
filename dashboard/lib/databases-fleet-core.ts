import { attentionItems, type AttentionItem, type ServerSnapshot } from "@/lib/attention-core";
import type { DatabaseStatus } from "@/lib/agent-types";

// Every database of every server as the Databases page lists it, the ones whose backup needs a look first. The
// judgement is the attention model's (failed, overdue, never scheduled); this adds what it leaves out on purpose (no
// backup configured, paused) so those are flagged too, and what to say about each. Pure: the page lays it out.

export type BackupState =
  | "failed"
  | "overdue"
  | "never-scheduled"
  | "not-configured"
  | "paused"
  | "first-pending"
  | "running"
  | "ok";

/** Lower is more urgent. */
const ORDER: Record<BackupState, number> = {
  failed: 0,
  overdue: 1,
  "never-scheduled": 1,
  "not-configured": 2,
  paused: 3,
  "first-pending": 4,
  running: 5,
  ok: 6,
};

/** Whether a state is something to act on: the rows to flag. Waiting for the first scheduled backup and a running one are not. */
export const isProblem = (state: BackupState): boolean => ORDER[state] <= ORDER.paused;

export interface DatabaseRow {
  server: { id: string; name: string };
  database: DatabaseStatus;
  state: BackupState;
  /** Why, with the cause the agent gave (the attention model's sentence); absent when there is nothing to say. */
  detail?: string;
}

export interface UnansweredServer {
  id: string;
  name: string;
  reason?: string;
}

function stateOf(db: DatabaseStatus, item: AttentionItem | undefined): BackupState {
  const b = db.backup;
  if (!b) return "not-configured";
  if (b.paused) return "paused";
  const run = b.last_run;
  if (run?.status === "failed") return "failed";
  if (!run) return b.next_run ? "first-pending" : "never-scheduled";
  if (run.status === "running") return "running";
  return item ? "overdue" : "ok";
}

/**
 * The rows, problems first (failed, then overdue or never scheduled, then not backed up at all, then paused), each group
 * by server and name. A server that did not answer, or whose database list failed, is returned apart as `unanswered`:
 * its databases are unknown, not absent. An agent with no apps file has no databases and is simply not listed.
 */
export function databaseRows(servers: ServerSnapshot[], now: number): { rows: DatabaseRow[]; unanswered: UnansweredServer[] } {
  const items = new Map(attentionItems(servers, now).filter((i) => i.kind === "backup").map((i) => [i.id, i]));
  const rows: DatabaseRow[] = [];
  const unanswered: UnansweredServer[] = [];
  for (const s of servers) {
    if (!s.reachable) {
      unanswered.push({ ...s.server, ...(s.reason === undefined ? {} : { reason: s.reason }) });
      continue;
    }
    if (s.errors?.databases !== undefined) {
      unanswered.push({ ...s.server, reason: s.errors.databases });
      continue;
    }
    for (const database of s.databases ?? []) {
      const item = items.get(`${s.server.id}:backup:${database.name}`);
      const state = stateOf(database, item);
      rows.push({ server: s.server, database, state, ...(item && (state === "failed" || state === "overdue" || state === "never-scheduled") ? { detail: item.message } : {}) });
    }
  }
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.server.name.localeCompare(b.server.name) || a.database.name.localeCompare(b.database.name));
  return { rows, unanswered };
}
