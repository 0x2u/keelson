import { describe, expect, it } from "vitest";
import { deploySummaryLine, formatSeconds, summarizeDeployments } from "@/lib/deploy-summary-core";
import type { DeploymentStatus } from "@/lib/agent-types";

const T0 = Date.parse("2026-10-20T10:00:00Z");
const dep = (status: DeploymentStatus, took?: number) => ({
  status,
  started_at: new Date(T0).toISOString(),
  finished_at: took === undefined ? undefined : new Date(T0 + took * 1000).toISOString(),
});

describe("summarizeDeployments", () => {
  it("counts successes, and failures of every kind apart", () => {
    const s = summarizeDeployments([dep("succeeded", 10), dep("failed", 5), dep("rolled_back", 60), dep("rollback_failed", 30), dep("succeeded", 20)]);
    expect(s).toMatchObject({ total: 5, succeeded: 2, failed: 3, running: 0 });
  });

  it("takes the median of the finished ones: the middle one, or the mean of the middle two", () => {
    expect(summarizeDeployments([dep("succeeded", 10), dep("failed", 100), dep("succeeded", 20)]).medianSeconds).toBe(20);
    expect(summarizeDeployments([dep("succeeded", 10), dep("succeeded", 21), dep("succeeded", 100), dep("failed", 1000)]).medianSeconds).toBe(61);
  });

  it("leaves a running deployment out of the duration and out of the failures", () => {
    const s = summarizeDeployments([dep("running"), dep("succeeded", 12)]);
    expect(s).toMatchObject({ total: 2, succeeded: 1, failed: 0, running: 1, medianSeconds: 12 });
  });

  it("has no median without a finished deployment, and nothing to say without any", () => {
    expect(summarizeDeployments([dep("running")]).medianSeconds).toBeNull();
    expect(summarizeDeployments([]).medianSeconds).toBeNull();
    expect(deploySummaryLine(summarizeDeployments([]))).toBe("");
  });

  it("ignores a finish time that is not after the start", () => {
    const bad = { status: "failed" as const, started_at: new Date(T0).toISOString(), finished_at: new Date(T0 - 5000).toISOString() };
    expect(summarizeDeployments([bad]).medianSeconds).toBeNull();
  });
});

describe("deploySummaryLine", () => {
  it("reads as one sentence", () => {
    expect(deploySummaryLine(summarizeDeployments([dep("succeeded", 10), dep("failed", 30), dep("succeeded", 20)]))).toBe(
      "Last 3 deployments: 2 succeeded, 1 failed or rolled back, median duration 20 s",
    );
  });

  it("says what is running, and uses the singular for one", () => {
    expect(deploySummaryLine(summarizeDeployments([dep("running")]))).toBe("Last 1 deployment: 0 succeeded, 0 failed or rolled back, 1 running");
  });
});

describe("formatSeconds", () => {
  it("uses seconds, then minutes, then hours", () => {
    expect(formatSeconds(12)).toBe("12 s");
    expect(formatSeconds(65)).toBe("1 min 5 s");
    expect(formatSeconds(3720)).toBe("1 h 2 min");
  });
});
