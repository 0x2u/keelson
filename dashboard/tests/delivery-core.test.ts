import { describe, expect, it } from "vitest";
import type { ServerDelivery } from "@/lib/agent-types";
import { duration, failureBand, fleetDelivery, frequency, frequencyBand, isRange, leadTimeBand, percent, quantile, restoreBand, type ServerReport } from "@/lib/delivery-core";

const answer = (over: Partial<ServerDelivery> = {}): ServerDelivery => ({
  range: "30d",
  from: "2026-10-13T00:00:00Z",
  to: "2026-11-12T00:00:00Z",
  days: 30,
  deployments: { total: 0, succeeded: 0, failed: 0, rolled_back: 0, rollback_failed: 0 },
  per_day: 0,
  change_failure_ratio: null,
  restore: { incidents: 0, median_seconds: null, longest_seconds: null, ongoing: 0, seconds: [] },
  lead_time: { deployments: 0, covered: null, median_seconds: null, p90_seconds: null, seconds: [] },
  ...over,
});

const report = (name: string, delivery: ServerDelivery | null, problem?: string): ServerReport => ({ server: { id: name, name }, delivery, problem });

describe("the fleet's delivery numbers", () => {
  it("adds up the outcomes and recomputes the rates over the whole fleet", () => {
    const a = answer({
      deployments: { total: 10, succeeded: 9, failed: 1, rolled_back: 0, rollback_failed: 0 },
      per_day: 0.3,
    });
    const b = answer({
      deployments: { total: 20, succeeded: 15, failed: 2, rolled_back: 2, rollback_failed: 1 },
      per_day: 0.5,
    });
    const fleet = fleetDelivery([report("a", a), report("b", b)]);
    expect(fleet.deployments).toEqual({ total: 30, succeeded: 24, failed: 3, rolledBack: 2, rollbackFailed: 1 });
    expect(fleet.perDay).toBeCloseTo(24 / 30);
    expect(fleet.changeFailureRatio).toBeCloseTo(6 / 30);
    expect(fleet.reporting).toBe(2);
  });

  it("pools the durations instead of averaging each server's median", () => {
    const a = answer({ restore: { incidents: 3, median_seconds: 60, longest_seconds: 600, ongoing: 0, seconds: [30, 60, 600] } });
    const b = answer({ restore: { incidents: 2, median_seconds: 1800, longest_seconds: 3600, ongoing: 1, seconds: [1800, 3600] } });
    const fleet = fleetDelivery([report("a", a), report("b", b)]);
    // 30, 60, 600, 1800, 3600: the median of the five is 600, not the mean of the two medians (930).
    expect(fleet.restore.medianSeconds).toBe(600);
    expect(fleet.restore.incidents).toBe(5);
    expect(fleet.restore.ongoing).toBe(1);
    expect(fleet.restore.longestSeconds).toBe(3600);
  });

  it("measures the lead time over the deployments that carry their commit, and says what share that is", () => {
    const a = answer({
      deployments: { total: 4, succeeded: 4, failed: 0, rolled_back: 0, rollback_failed: 0 },
      lead_time: { deployments: 2, covered: 0.5, median_seconds: 900, p90_seconds: 1500, seconds: [600, 1200] },
    });
    const b = answer({
      deployments: { total: 2, succeeded: 2, failed: 0, rolled_back: 0, rollback_failed: 0 },
      lead_time: { deployments: 2, covered: 1, median_seconds: 3600, p90_seconds: 7200, seconds: [3000, 7200] },
    });
    const fleet = fleetDelivery([report("a", a), report("b", b)]);
    expect(fleet.leadTime.deployments).toBe(4);
    expect(fleet.leadTime.covered).toBeCloseTo(4 / 6);
    expect(fleet.leadTime.medianSeconds).toBe((1200 + 3000) / 2);
  });

  it("counts a server that did not answer without letting it change the numbers", () => {
    const fleet = fleetDelivery([
      report("a", answer({ deployments: { total: 2, succeeded: 2, failed: 0, rolled_back: 0, rollback_failed: 0 } })),
      report("b", null, "this agent is too old"),
    ]);
    expect(fleet.servers).toBe(2);
    expect(fleet.reporting).toBe(1);
    expect(fleet.deployments.total).toBe(2);
  });

  it("has nothing to show for a fleet that answered nothing", () => {
    const fleet = fleetDelivery([report("a", null, "unreachable")]);
    expect(fleet.changeFailureRatio).toBeNull();
    expect(fleet.restore.medianSeconds).toBeNull();
    expect(fleet.leadTime.medianSeconds).toBeNull();
    expect(fleet.perDay).toBe(0);
  });
});

describe("how the numbers read", () => {
  it("says a frequency as a rate above one a day and as an interval below it", () => {
    expect(frequency(0)).toBe("none");
    expect(frequency(3.24)).toBe("3.2 a day");
    expect(frequency(12.4)).toBe("12 a day");
    expect(frequency(1 / 4)).toBe("every 4 days");
    expect(frequency(1 / 7.5)).toBe("every 7.5 days");
    expect(frequency(1 / 28)).toBe("every 4 weeks");
  });

  it("says a duration in the largest unit that still means something", () => {
    expect(duration(null)).toBeNull();
    expect(duration(42)).toBe("42 s");
    expect(duration(300)).toBe("5 min");
    expect(duration(3600 * 3 + 1200)).toBe("3 h 20");
    expect(duration(7200)).toBe("2 h");
    expect(duration(4 * 24 * 3600)).toBe("4 days");
  });

  it("says a ratio as a percentage, with a decimal only where rounding would hide the difference", () => {
    expect(percent(null)).toBeNull();
    expect(percent(0)).toBe("0 %");
    expect(percent(0.034)).toBe("3.4 %");
    expect(percent(0.2)).toBe("20 %");
  });

  it("puts each measure in its DORA band", () => {
    expect(frequencyBand(2)).toBe("elite");
    expect(frequencyBand(1)).toBe("high"); // exactly once a day is the top of the high band, not the elite one
    expect(frequencyBand(1 / 3)).toBe("high");
    expect(frequencyBand(1 / 20)).toBe("medium");
    expect(frequencyBand(1 / 60)).toBe("low");
    expect(frequencyBand(0)).toBe("unknown");

    expect(leadTimeBand(3600)).toBe("elite");
    expect(leadTimeBand(3 * 24 * 3600)).toBe("high");
    expect(leadTimeBand(60 * 24 * 3600)).toBe("low");
    expect(leadTimeBand(null)).toBe("unknown");

    expect(restoreBand(600)).toBe("elite");
    expect(restoreBand(5 * 3600)).toBe("high");
    expect(restoreBand(3 * 24 * 3600)).toBe("medium");
    expect(restoreBand(null)).toBe("unknown");

    expect(failureBand(0.02)).toBe("elite");
    expect(failureBand(0.08)).toBe("high");
    expect(failureBand(0.3)).toBe("low");
    expect(failureBand(null)).toBe("unknown");
  });

  it("interpolates a quantile and refuses nothing", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7);
  });

  it("only accepts the windows the agent serves", () => {
    expect(isRange("7d")).toBe(true);
    expect(isRange("90d")).toBe(false);
    expect(isRange(undefined)).toBe(false);
  });
});
