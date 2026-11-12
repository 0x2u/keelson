import { describe, expect, it } from "vitest";
import { coverage, niceMax, parseRange, shape, withValue } from "@/lib/history-core";
import type { HostPoint, StatsPoint } from "@/lib/agent-types";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const pt = (sec: number, cpu: number, max = cpu): StatsPoint => ({
  time: new Date(T0 + sec * 1000).toISOString(),
  cpu_percent: cpu,
  cpu_max: max,
  mem_usage: 0,
  mem_max: 0,
  mem_limit: 0,
});
const cpu = (p: StatsPoint) => ({ avg: p.cpu_percent, peak: p.cpu_max });

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(7, 0)).toBe(10);
    expect(niceMax(10, 0)).toBe(10);
    expect(niceMax(11, 0)).toBe(20);
    expect(niceMax(130, 0)).toBe(200);
    expect(niceMax(310, 0)).toBe(500);
    expect(niceMax(0.3, 0)).toBe(0.5);
    expect(niceMax(520_000_000, 0)).toBe(1_000_000_000);
  });
  it("never goes below the floor, so an idle container is not a wall of noise", () => {
    expect(niceMax(0, 10)).toBe(10);
    expect(niceMax(1.2, 10)).toBe(10);
  });
});

describe("parseRange", () => {
  it("accepts the offered ranges and falls back to an hour", () => {
    expect(parseRange("6h")).toBe("6h");
    expect(parseRange("24h")).toBe("24h");
    expect(parseRange("48h")).toBe("1h");
    expect(parseRange(undefined)).toBe("1h");
    expect(parseRange(["6h"])).toBe("1h");
  });
});

describe("shape", () => {
  it("puts time on x and the value on y, with 0 at the bottom", () => {
    const s = shape([pt(0, 0), pt(60, 50, 100)], cpu, T0, T0 + 120_000, 100, 120, 40, 90_000);
    expect(s.line).toBe("0.0,40.0 60.0,20.0");
    expect(s.peak).toBe("0.0,40.0 60.0,0.0");
    expect(s.area).toBe("0.0,40.0 0.0,40.0 60.0,20.0 60.0,40.0");
  });

  it("clamps a value above the axis instead of drawing outside the box", () => {
    expect(shape([pt(0, 500)], cpu, T0, T0 + 1000, 100, 100, 10, 5000).line).toBe("0.0,0.0");
  });

  it("breaks the line across a gap rather than joining the two sides", () => {
    const s = shape([pt(0, 10), pt(30, 10), pt(600, 10), pt(630, 10)], cpu, T0, T0 + 630_000, 100, 630, 10, 90_000);
    expect(s.line.split(" | ")).toHaveLength(2);
    expect(s.line.split(" | ")[1]).toBe("600.0,9.0 630.0,9.0");
  });
});

describe("coverage", () => {
  const at = (sec: number) => ({ time: new Date(T0 + sec * 1000).toISOString() });
  const HOUR = 3600;
  it("is empty without points", () => {
    expect(coverage([], T0, T0 + HOUR * 1000, 30)).toEqual({ kind: "empty" });
  });
  it("says a recording that just began is starting", () => {
    const now = T0 + 150 * 1000;
    expect(coverage([at(0), at(30), at(60), at(90), at(120)], now - HOUR * 1000, now, 30)).toEqual({ kind: "starting", since: at(0).time });
  });
  it("says a recording that began part-way through the range is partial, with where it began", () => {
    const now = T0 + 2 * HOUR * 1000;
    const points = Array.from({ length: 20 }, (_, i) => at(HOUR + i * 30));
    expect(coverage(points, now - 6 * HOUR * 1000, now, 90)).toEqual({ kind: "partial", since: at(HOUR).time });
  });
  it("calls a range filled from its start full, within a couple of points of slack", () => {
    const now = T0 + HOUR * 1000;
    const points = Array.from({ length: 118 }, (_, i) => at(i * 30 + 30));
    expect(coverage(points, T0, now, 30)).toEqual({ kind: "full" });
  });
});

describe("withValue", () => {
  it("keeps the points that carry the value, zero included", () => {
    const base = { time: "2026-10-20T10:00:00Z" };
    const pts: HostPoint[] = [{ ...base, load: 0 }, { ...base }, { ...base, load: 2, mem_percent: 10 }];
    expect(withValue(pts, "load")).toHaveLength(2);
    expect(withValue(pts, "mem_percent")).toHaveLength(1);
    expect(withValue(pts, "disk_percent")).toHaveLength(0);
  });
});
