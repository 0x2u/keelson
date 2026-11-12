import type { HostPoint } from "@/lib/agent-types";

export const RANGES = ["1h", "6h", "24h"] as const;
export type Range = (typeof RANGES)[number];

export function parseRange(v: string | string[] | undefined): Range {
  return RANGES.find((r) => r === v) ?? "1h";
}

const RANGE_SECONDS: Record<Range, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600 };
export const rangeSeconds = (r: Range) => RANGE_SECONDS[r];

/** The top of a chart's axis: the smallest "round" number (1, 2, 5 times a power of ten) above the value, never below `floor`. */
export function niceMax(value: number, floor: number): number {
  const v = Math.max(value, floor);
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

export interface Shape {
  /** Points of the average line, "x,y x,y ...". */
  line: string;
  /** The same line closed down to the baseline, to fill. */
  area: string;
  /** The peak line. */
  peak: string;
}

/**
 * Lays points out in a width x height box, time on x over [from, to] (milliseconds) and the value on y from 0 to max. A gap
 * longer than `gap` milliseconds (the agent was down, the container did not run) breaks the line instead of joining across it:
 * the polylines come back separated by " | ".
 */
export function shape<P extends { time: string }>(
  points: P[],
  pick: (p: P) => { avg: number; peak: number },
  from: number,
  to: number,
  max: number,
  width: number,
  height: number,
  gap: number,
): Shape {
  const x = (t: number) => ((t - from) / Math.max(to - from, 1)) * width;
  const y = (v: number) => height - (Math.min(Math.max(v, 0), max) / max) * height;
  const runs: P[][] = [];
  for (const p of points) {
    const t = Date.parse(p.time);
    const run = runs[runs.length - 1];
    if (run && t - Date.parse(run[run.length - 1].time) <= gap) run.push(p);
    else runs.push([p]);
  }
  const f = (n: number) => n.toFixed(1);
  const lines: string[] = [];
  const areas: string[] = [];
  const peaks: string[] = [];
  for (const run of runs) {
    const avg = run.map((p) => `${f(x(Date.parse(p.time)))},${f(y(pick(p).avg))}`);
    const peak = run.map((p) => `${f(x(Date.parse(p.time)))},${f(y(pick(p).peak))}`);
    const x0 = f(x(Date.parse(run[0].time)));
    const x1 = f(x(Date.parse(run[run.length - 1].time)));
    lines.push(avg.join(" "));
    peaks.push(peak.join(" "));
    areas.push(`${x0},${f(height)} ${avg.join(" ")} ${x1},${f(height)}`);
  }
  return { line: lines.join(" | "), area: areas.join(" | "), peak: peaks.join(" | ") };
}

/** How much of a chart's range the recorded points cover, so the page can say so instead of showing a chart that looks complete. */
export type Coverage =
  | { kind: "empty" }
  /** Under five minutes of samples: a line is not yet a trend. */
  | { kind: "starting"; since: string }
  /** Recording began part-way through the range: the left of the chart is empty because nothing was recorded. */
  | { kind: "partial"; since: string }
  | { kind: "full" };

const STARTING_MS = 5 * 60 * 1000;

/**
 * Judges the points of a history over [from, to] (milliseconds). `stepSeconds` is the width of a point: the first point sits
 * at the start of its bucket, so recording that began within about two points of `from` counts as the whole range.
 */
export function coverage(points: { time: string }[], from: number, to: number, stepSeconds: number): Coverage {
  if (points.length === 0) return { kind: "empty" };
  const first = Date.parse(points[0].time);
  const last = Date.parse(points[points.length - 1].time);
  if (last - first < STARTING_MS && to - first < STARTING_MS * 2) return { kind: "starting", since: points[0].time };
  if (first - from > stepSeconds * 2 * 1000) return { kind: "partial", since: points[0].time };
  return { kind: "full" };
}

/** The points that carry a value, as the chart's `pick` needs them. */
export function withValue<P extends HostPoint>(points: P[], key: "load" | "mem_percent" | "disk_percent"): P[] {
  return points.filter((p) => typeof p[key] === "number");
}
