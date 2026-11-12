import type { AlertFailure, DatabaseBackup, KeyProof, KeyProofReason, RestoreTest, RestoreTestTable } from "@/lib/agent-types";
import { firstLine } from "@/lib/attention-core";
import { extractIdentity } from "@/lib/database-restore";

// What the three actions of the checklist (prove the key, test a restore, send a test alert) say about what happened. Pure: the
// dialogs lay it out. Nothing here ever holds a secret key: the dialogs clear it once the request is sent.

/** How often a running restore test is asked about, and how long the dialog waits before it says the agent is taking long. */
export const TEST_POLL_MS = 2000;
export const TEST_GIVE_UP_MS = 15 * 60_000;

export const KEY_PROBLEM = "Paste the age secret key: it starts with AGE-SECRET-KEY-1.";

/** The key as the agent should get it, or the problem with what was pasted. */
export function keyInput(pasted: string): { identity: string; problem?: undefined } | { identity?: undefined; problem: string } {
  const identity = extractIdentity(pasted);
  return identity === "" ? { problem: KEY_PROBLEM } : { identity };
}

/** The backup a test uses when the operator does not choose: the newest scheduled or manual one (not taken before a deployment or a restore). */
export function defaultTestBackup(backups: DatabaseBackup[]): string {
  const newest = (list: DatabaseBackup[]) => [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return (newest(backups.filter((b) => b.kind === undefined)) ?? newest(backups))?.key ?? "";
}

const KEY_REASONS: Record<KeyProofReason, string> = {
  wrong_key: "That key does not open this backup: it is not one of the keys the backup was encrypted to.",
  not_age: "That file is not an age-encrypted backup, so no key can open it.",
  no_backup: "There is no backup to check yet.",
  fetch_failed: "The backup could not be read from its destination. Try again; if it keeps failing, check the destination.",
};

export interface KeyProofView {
  ok: boolean;
  text: string;
}

/** The answer of the key proof in words. A wrong key is a result, not an error. */
export function keyProofView(result: KeyProof): KeyProofView {
  if (!result.ok) return { ok: false, text: KEY_REASONS[result.reason] };
  return { ok: true, text: `The key opens the backup of ${result.backup_time.slice(0, 16).replace("T", " ")} UTC.` };
}

const CHANNEL = { telegram: "Telegram", webhook: "Webhook" } as const;
const CHANNEL_FAILURES: Record<AlertFailure, string> = {
  timeout: "did not answer in time",
  refused: "refused the connection",
  rejected: "answered but did not accept the message",
  other: "failed",
};

export interface AlertRow {
  channel: string;
  ok: boolean;
  text: string;
}

/** One line per channel; never the text of an error, which could quote a URL or a token. */
export function alertRows(channels: { channel: "telegram" | "webhook"; ok: boolean; reason?: AlertFailure }[]): AlertRow[] {
  return channels.map((c) => ({ channel: CHANNEL[c.channel], ok: c.ok, text: c.ok ? "delivered" : CHANNEL_FAILURES[c.reason ?? "other"] }));
}

/** The sentence over the rows: nothing to test, everything delivered, or what did not. */
export function alertSummary(rows: AlertRow[]): { ok: boolean; text: string } {
  if (rows.length === 0) return { ok: false, text: "No alert channel is configured on this server, so nothing was sent." };
  const failed = rows.filter((r) => !r.ok);
  if (failed.length === 0) return { ok: true, text: rows.length === 1 ? "The test message was delivered." : "The test message was delivered on every channel." };
  return { ok: false, text: failed.length === rows.length ? "The test message was not delivered." : "The test message was not delivered on every channel." };
}

/** What the verdict means, in the wording of the rule the agent applies (see the agent's restore test). */
export const VERDICT_RULE =
  "Passed means the restore completed without error, the restored database has at least one table, and it holds rows unless the live database holds none. The counts differ because the backup is older: that is reported, not judged.";

export interface RestoreRow {
  table: string;
  backup: string;
  live: string;
}

const count = (n: number | null): string => (n === null ? "not there" : n.toLocaleString("en-US"));

/** The tables of a test as rows "in the backup / now", the tables that differ in presence (only in one of them) last. */
export function restoreRows(tables: RestoreTestTable[] | null): RestoreRow[] {
  const both = (t: RestoreTestTable) => t.backup_rows !== null && t.live_rows !== null;
  return [...(tables ?? [])]
    .sort((a, b) => Number(!both(a)) - Number(!both(b)) || a.name.localeCompare(b.name))
    .map((t) => ({ table: t.name, backup: count(t.backup_rows), live: count(t.live_rows) }));
}

export type TestProgress = { phase: "running" } | { phase: "passed" | "failed"; headline: string; error?: string; rows: RestoreRow[] };

/** Where a restore test stands, with its table rows once it has finished. */
export function testProgress(test: RestoreTest): TestProgress {
  if (test.status === "running") return { phase: "running" };
  const rows = restoreRows(test.tables);
  if (test.status === "passed") return { phase: "passed", headline: `The backup of ${test.backup_time.slice(0, 16).replace("T", " ")} UTC restored.`, rows };
  const error = firstLine(test.error);
  return { phase: "failed", headline: "The restore did not complete.", ...(error ? { error } : {}), rows };
}

/** The toasts of the three actions: sentence case, no trailing period. */
export const readinessToast = {
  keyProven: (database: string): string => `Key proven for ${database}`,
  restorePassed: (database: string): string => `Restore test of ${database} passed`,
  restoreFailed: (database: string): string => `Restore test of ${database} failed`,
  alertDelivered: "Test alert delivered",
  alertNotDelivered: "Test alert not delivered",
} as const;
