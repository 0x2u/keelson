import type { AppAvailability } from "@/lib/agent-types";

export const AVAILABILITY_RANGES = ["24h", "7d", "30d"] as const;
export type AvailabilityRange = (typeof AVAILABILITY_RANGES)[number];

export function parseAvailabilityRange(v: string | string[] | undefined): AvailabilityRange {
  return AVAILABILITY_RANGES.find((r) => r === v) ?? "24h";
}

const LABEL: Record<AvailabilityRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export const availabilityRangeLabel = (r: AvailabilityRange) => LABEL[r];

/**
 * "99.95%". Never "100%" while there was downtime: an app that was down for a minute in a month is not at 100%, however the
 * rounding falls. The most it shows then is 99.99%.
 */
export function formatUptime(percent: number, downSeconds: number): string {
  if (downSeconds <= 0 && percent >= 100) return "100%";
  const capped = Math.min(percent, downSeconds > 0 ? 99.99 : 100);
  return `${capped.toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** "45 s", "12 min", "2 h 5 min", "1 d 3 h": an incident's length, coarser as it grows. */
export function formatIncident(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`.replace(" 0 min", "");
  return `${Math.floor(seconds / 86400)} d ${Math.round((seconds % 86400) / 3600)} h`.replace(" 0 h", "");
}

export type AvailabilityView =
  /** The app has not been judged yet (not deployed, or the agent only just started watching). */
  | { kind: "none" }
  /** Judged, but not for long enough to say a percentage. */
  | { kind: "just-started"; since: string }
  | { kind: "known"; uptime: string; down: boolean; partial: boolean; since: string; ongoing: boolean };

/** What the card says. `partial` is when the agent has watched the app for less than the range: the percentage is then over `since` on only. */
export function availabilityView(a: AppAvailability): AvailabilityView {
  if (a.since === null) return { kind: "none" };
  if (a.uptime_percent === null) return { kind: "just-started", since: a.since };
  return {
    kind: "known",
    uptime: formatUptime(a.uptime_percent, a.down_seconds),
    down: a.down_seconds > 0,
    partial: Date.parse(a.since) - Date.parse(a.from) > 1000,
    since: a.since,
    ongoing: a.incidents.some((i) => i.end === null),
  };
}

/** How many incidents the card lists. */
export const SHOWN_INCIDENTS = 5;
