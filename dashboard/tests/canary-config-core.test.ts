import { describe, expect, it } from "vitest";
import { analysisErrors, emptyMetric, type MetricDraft } from "@/lib/analysis-config-core";
import { canaryErrors, canaryFromDraft, stepsDraft } from "@/lib/canary-config-core";

const metric = (over: Partial<MetricDraft> = {}): MetricDraft => ({ ...emptyMetric(), name: "error-rate", query: "up", max: "1", ...over });

describe("the canary of an app form", () => {
  it("round trips: steps as text, the hold as typed", () => {
    expect(stepsDraft({ canary: { steps: [10, 50] } })).toBe("10, 50");
    expect(stepsDraft(undefined)).toBe("");
    expect(canaryFromDraft("10, 50", "2m")).toEqual({ steps: [10, 50], hold: "2m" });
    expect(canaryFromDraft("10 50", "")).toEqual({ steps: [10, 50] });
    expect(canaryFromDraft(stepsDraft({ canary: { steps: [5, 25, 75] } }), " ")).toEqual({ steps: [5, 25, 75] });
  });

  it("sends nothing when the steps are blank, and says nothing about a lone hold", () => {
    expect(canaryFromDraft("  ", "2m")).toBeUndefined();
    expect(canaryErrors("", "nonsense")).toEqual({});
  });

  it("accepts one to five rising steps", () => {
    expect(canaryErrors("10", "")).toEqual({});
    expect(canaryErrors("1, 2, 3, 4, 99", "1m")).toEqual({});
  });

  it("refuses more than five steps", () => {
    expect(canaryErrors("1,2,3,4,5,6", "")["canary.steps"]).toBe("canary lists 6 steps: between 1 and 5, such as steps: [10, 50]");
  });

  it("refuses a step outside 1 to 99, or that is not a whole number", () => {
    expect(canaryErrors("10, 100", "")["canary.steps"]).toBe("canary.steps[1] is 100: a step is a percentage from 1 to 99 (100 is the end of the rollout, it needs no step)");
    expect(canaryErrors("0", "")["canary.steps"]).toMatch(/^canary\.steps\[0\] is 0:/);
    expect(canaryErrors("10, 2.5", "")["canary.steps"]).toMatch(/^canary\.steps\[1\] is 2\.5:/);
    expect(canaryErrors("ten", "")["canary.steps"]).toMatch(/^canary\.steps\[0\] is ten:/);
  });

  it("refuses steps that do not rise", () => {
    expect(canaryErrors("50, 10", "")["canary.steps"]).toBe("the steps must rise");
    expect(canaryErrors("10, 10", "")["canary.steps"]).toBe("the steps must rise");
  });

  it("holds each step from 10s to 10m", () => {
    expect(canaryErrors("10", "10s")).toEqual({});
    expect(canaryErrors("10", "10m")).toEqual({});
    expect(canaryErrors("10", "9s")["canary.hold"]).toBe("canary.hold must be between 10s and 10m");
    expect(canaryErrors("10", "11m")["canary.hold"]).toBe("canary.hold must be between 10s and 10m");
    expect(canaryErrors("10", "soon")["canary.hold"]).toMatch(/number and a unit/);
  });
});

describe("the metric gates next to a canary", () => {
  it("allow a soak of 0s when there are canary steps, and still refuse it without", () => {
    expect(analysisErrors("", [metric()], "0s", { hold: "" })).toEqual({});
    expect(analysisErrors("", [metric()], "0s", null).analysis).toMatch(/more than 0s/);
  });

  it("must be able to trip inside the shortest watch: the hold", () => {
    const e = analysisErrors("", [metric()], "5m", { hold: "20s" }); // 20s / 10s = 2 evaluations, the default limit is 3
    expect(e["analysis.0.failure_limit"]).toMatch(/canary hold holds 2 evaluations/);
    expect(analysisErrors("", [metric()], "5m", { hold: "30s" })).toEqual({});
    expect(analysisErrors("", [metric()], "0s", { hold: "20s" })["analysis.0.failure_limit"]).toMatch(/canary hold holds 2 evaluations/);
  });

  it("must be able to trip inside the soak when that is the shorter watch", () => {
    expect(analysisErrors("", [metric()], "20s", { hold: "5m" })["analysis.0.failure_limit"]).toMatch(/soak holds 2 evaluations/);
  });
});
