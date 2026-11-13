import type { ServerDelivery } from "@/lib/agent-types";

// The four numbers a delivery team is judged by (DORA), for the whole fleet. Each agent computes its own over the same
// window and sends the durations it measured, not only its medians: a median of medians is not a median, so the pooling
// happens here, over the values themselves.
//
// Nothing here is desired state and nothing is stored: it is what the servers answered, added up.

/** The windows the page offers; the agent keeps outages for 30 days, which is the longest. */
export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

export function isRange(value: string | undefined): value is Range {
  return RANGES.includes(value as Range);
}

/** One server's answer, or why it is missing. */
export interface ServerReport {
  server: { id: string; name: string };
  delivery: ServerDelivery | null;
  /** Set when the server could not be read, or is too old for the route. */
  problem?: string;
}

export interface FleetDelivery {
  days: number;
  servers: number;
  /** Servers that answered with numbers. */
  reporting: number;
  deployments: { total: number; succeeded: number; failed: number; rolledBack: number; rollbackFailed: number };
  /** Successful deployments a day across the fleet. */
  perDay: number;
  /** Share of finished deployments that did not leave the new version serving; null when none finished. */
  changeFailureRatio: number | null;
  restore: { incidents: number; ongoing: number; medianSeconds: number | null; longestSeconds: number | null };
  leadTime: { deployments: number; covered: number | null; medianSeconds: number | null; p90Seconds: number | null };
}

/** The quantile of a sorted list, interpolated; null for an empty one. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The fleet's numbers from what each server answered. Servers that did not answer are counted but add nothing. */
export function fleetDelivery(reports: ServerReport[]): FleetDelivery {
  const answered = reports.flatMap((r) => (r.delivery === null ? [] : [r.delivery]));
  const out: FleetDelivery = {
    days: answered[0]?.days ?? 0,
    servers: reports.length,
    reporting: answered.length,
    deployments: { total: 0, succeeded: 0, failed: 0, rolledBack: 0, rollbackFailed: 0 },
    perDay: 0,
    changeFailureRatio: null,
    restore: { incidents: 0, ongoing: 0, medianSeconds: null, longestSeconds: null },
    leadTime: { deployments: 0, covered: null, medianSeconds: null, p90Seconds: null },
  };
  const restores: number[] = [];
  const leads: number[] = [];
  let succeededWithoutLead = 0;
  for (const d of answered) {
    out.deployments.total += d.deployments.total;
    out.deployments.succeeded += d.deployments.succeeded;
    out.deployments.failed += d.deployments.failed;
    out.deployments.rolledBack += d.deployments.rolled_back;
    out.deployments.rollbackFailed += d.deployments.rollback_failed;
    out.restore.incidents += d.restore.incidents;
    out.restore.ongoing += d.restore.ongoing;
    restores.push(...d.restore.seconds);
    leads.push(...d.lead_time.seconds);
    out.leadTime.deployments += d.lead_time.deployments;
    succeededWithoutLead += d.deployments.succeeded;
    if (d.restore.longest_seconds !== null) out.restore.longestSeconds = Math.max(out.restore.longestSeconds ?? 0, d.restore.longest_seconds);
  }
  if (out.days > 0) out.perDay = out.deployments.succeeded / out.days;
  if (out.deployments.total > 0) out.changeFailureRatio = (out.deployments.total - out.deployments.succeeded) / out.deployments.total;
  restores.sort((a, b) => a - b);
  leads.sort((a, b) => a - b);
  out.restore.medianSeconds = quantile(restores, 0.5);
  out.leadTime.medianSeconds = quantile(leads, 0.5);
  out.leadTime.p90Seconds = quantile(leads, 0.9);
  if (succeededWithoutLead > 0) out.leadTime.covered = out.leadTime.deployments / succeededWithoutLead;
  return out;
}

/** A duration in words: "4 min", "3 h 20", "2 days". Null for null. */
export function duration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
  }
  return `${Math.round(s / (24 * 3600))} days`;
}

/** The deployment frequency in words: more than one a day is "3.2 a day", less is "every 4 days". */
export function frequency(perDay: number): string {
  if (perDay <= 0) return "none";
  if (perDay >= 1) return `${perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)} a day`;
  const days = 1 / perDay;
  return days < 14 ? `every ${Number(days.toFixed(1))} days` : `every ${Math.round(days / 7)} weeks`;
}

/** A ratio as a percentage, with one decimal under 10 %. Null for null. */
export function percent(ratio: number | null): string | null {
  if (ratio === null) return null;
  const p = ratio * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)} %`;
}

/**
 * DORA's own bands for the four measures, so a number reads as a judgement and not as trivia: the clusters of the 2023
 * State of DevOps report (elite: lead time under a day, deployments on demand, 5 % of changes failing, recovery under an
 * hour; high: a week, daily to weekly, 10 %, a day; medium: a month, weekly to monthly, 15 %, a week). A figure the
 * fleet cannot measure has none.
 */
export type Band = "elite" | "high" | "medium" | "low" | "unknown";

export function frequencyBand(perDay: number): Band {
  if (perDay <= 0) return "unknown";
  if (perDay > 1) return "elite"; // on demand: more than once a day
  if (perDay >= 1 / 7) return "high"; // between once a day and once a week
  if (perDay >= 1 / 30) return "medium"; // between once a week and once a month
  return "low";
}

export function leadTimeBand(seconds: number | null): Band {
  if (seconds === null) return "unknown";
  if (seconds < 24 * 3600) return "elite";
  if (seconds < 7 * 24 * 3600) return "high";
  if (seconds < 30 * 24 * 3600) return "medium";
  return "low";
}

export function restoreBand(seconds: number | null): Band {
  if (seconds === null) return "unknown";
  if (seconds < 3600) return "elite";
  if (seconds < 24 * 3600) return "high";
  if (seconds < 7 * 24 * 3600) return "medium";
  return "low";
}

export function failureBand(ratio: number | null): Band {
  if (ratio === null) return "unknown";
  if (ratio <= 0.05) return "elite";
  if (ratio <= 0.1) return "high";
  if (ratio <= 0.15) return "medium";
  return "low";
}
