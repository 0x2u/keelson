import type { JobRun } from "@/lib/agent-types";

/** The id of the element of one run in a list: the target of the toast's link (#run-<id>). */
export function runAnchor(runId: string): string {
  return `run-${runId}`;
}

/** The run named by the page's `?run=` parameter, when there is one (the parameter may repeat). */
export function highlightedRun(param: string | string[] | undefined): string | undefined {
  const value = Array.isArray(param) ? param[0] : param;
  return value === undefined || value === "" ? undefined : value;
}

export interface RowCounts {
  /** "row counts (public schema, 2 tables)" */
  summary: string;
  tables: { name: string; rows: number }[];
}

const ROW_COUNTS = /^(row counts \([^)]*\)): (.+)$/;

/**
 * The row counts a restore ends with (its last line: "row counts (public schema, 2 tables): orders=7, users=42"), to
 * compare with the source. Null when the output has none: a backup, a failed restore, or counts that were unavailable.
 */
export function parseRowCounts(output: string | undefined): RowCounts | null {
  if (!output) return null;
  const lines = output.trimEnd().split("\n");
  const m = ROW_COUNTS.exec(lines[lines.length - 1] ?? "");
  if (!m) return null;
  const tables: RowCounts["tables"] = [];
  for (const part of m[2].split(", ")) {
    const at = part.lastIndexOf("=");
    const rows = Number(part.slice(at + 1));
    if (at <= 0 || !Number.isInteger(rows) || rows < 0) continue;
    tables.push({ name: part.slice(0, at), rows });
  }
  return tables.length === 0 ? null : { summary: m[1], tables };
}

/** The most recent of the runs, by start time. */
export function latestRun(runs: JobRun[] | undefined): JobRun | undefined {
  let best: JobRun | undefined;
  for (const r of runs ?? []) if (best === undefined || Date.parse(r.started_at) > Date.parse(best.started_at)) best = r;
  return best;
}

/** Whether a page showing these runs should keep refreshing: one is still running. */
export function anyRunning(...lists: (JobRun[] | undefined)[]): boolean {
  return lists.some((runs) => runs?.some((r) => r.status === "running"));
}
