import { describe, expect, it } from "vitest";
import { availabilityView, formatIncident, formatUptime, parseAvailabilityRange } from "@/lib/availability-core";
import type { AppAvailability } from "@/lib/agent-types";

const base: AppAvailability = {
  app: "web",
  range: "7d",
  from: "2026-10-13T10:00:00Z",
  to: "2026-10-20T10:00:00Z",
  since: "2026-10-13T10:00:00Z",
  covered_seconds: 7 * 86400,
  down_seconds: 0,
  uptime_percent: 100,
  incidents: [],
};

describe("parseAvailabilityRange", () => {
  it("accepts the three ranges and falls back to a day", () => {
    expect(parseAvailabilityRange("7d")).toBe("7d");
    expect(parseAvailabilityRange("30d")).toBe("30d");
    expect(parseAvailabilityRange("1h")).toBe("24h");
    expect(parseAvailabilityRange(undefined)).toBe("24h");
    expect(parseAvailabilityRange(["7d"])).toBe("24h");
  });
});

describe("formatUptime", () => {
  it("drops useless decimals", () => {
    expect(formatUptime(100, 0)).toBe("100%");
    expect(formatUptime(99.5, 100)).toBe("99.5%");
    expect(formatUptime(99.95, 100)).toBe("99.95%");
    expect(formatUptime(90, 3600)).toBe("90%");
  });
  it("never says 100% when the app was down", () => {
    expect(formatUptime(99.9996, 1)).toBe("99.99%");
    expect(formatUptime(100, 1)).toBe("99.99%");
  });
});

describe("formatIncident", () => {
  it("gets coarser as it grows", () => {
    expect(formatIncident(45)).toBe("45 s");
    expect(formatIncident(720)).toBe("12 min");
    expect(formatIncident(7500)).toBe("2 h 5 min");
    expect(formatIncident(7200)).toBe("2 h");
    expect(formatIncident(97200)).toBe("1 d 3 h");
    expect(formatIncident(86400)).toBe("1 d");
  });
});

describe("availabilityView", () => {
  it("has nothing to say about an app that was not judged", () => {
    expect(availabilityView({ ...base, since: null, uptime_percent: null })).toEqual({ kind: "none" });
  });
  it("says so when it only just started", () => {
    expect(availabilityView({ ...base, since: base.to, uptime_percent: null, covered_seconds: 0 })).toEqual({ kind: "just-started", since: base.to });
  });
  it("marks a record shorter than the range as partial, with where it starts", () => {
    const v = availabilityView({ ...base, since: "2026-10-18T10:00:00Z" });
    expect(v).toMatchObject({ kind: "known", partial: true, since: "2026-10-18T10:00:00Z", uptime: "100%", down: false });
    expect(availabilityView(base)).toMatchObject({ partial: false });
  });
  it("tells an ongoing incident and downtime", () => {
    const v = availabilityView({ ...base, uptime_percent: 99.9, down_seconds: 600, incidents: [{ start: "2026-10-20T09:50:00Z", end: null, duration_seconds: 600 }] });
    expect(v).toMatchObject({ kind: "known", uptime: "99.9%", down: true, ongoing: true });
  });
});
