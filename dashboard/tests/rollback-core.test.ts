import { describe, expect, it } from "vitest";
import type { Deployment } from "@/lib/agent-types";
import { recentVersions, rollbackPlan } from "@/lib/rollback-core";

let n = 0;
const dep = (ref: string, status: Deployment["status"], minute: number, over: Partial<Deployment> = {}): Deployment => ({
  id: `d${++n}`,
  app: "web",
  ref,
  status,
  trigger: "api",
  started_at: `2026-10-20T10:${String(minute).padStart(2, "0")}:00Z`,
  ...over,
});

// Newest first, as the agent lists them.
const history = [dep("r:v3", "succeeded", 30), dep("r:v3", "failed", 25), dep("r:v2", "rolled_back", 20), dep("r:v2", "succeeded", 10), dep("r:v1", "succeeded", 5)];

describe("rollbackPlan: the agent's rule (newest successful deployment whose ref is not the serving one)", () => {
  it("picks the previous version, skipping failed and rolled back deployments and repeats of the serving ref", () => {
    const plan = rollbackPlan(history, "r:v3");
    expect(plan.ok && plan.target.ref).toBe("r:v2");
    expect(plan.ok && plan.target.started_at).toBe("2026-10-20T10:10:00Z");
  });
  it("goes further back when the serving version is an older one", () => {
    const plan = rollbackPlan(history, "r:v2");
    expect(plan.ok && plan.target.ref).toBe("r:v3");
  });
  it("finds the newest success even when the history is given oldest first", () => {
    const plan = rollbackPlan([...history].reverse(), "r:v3");
    expect(plan.ok && plan.target.ref).toBe("r:v2");
  });
  it("takes the newest success when nothing serves (the current ref is empty)", () => {
    const plan = rollbackPlan(history, "");
    expect(plan.ok && plan.target.ref).toBe("r:v3");
  });
  it("has no target when every success ran the serving image", () => {
    const plan = rollbackPlan([dep("r:v3", "succeeded", 3), dep("r:v3", "succeeded", 1)], "r:v3");
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/no other version/);
  });
  it("has no target when nothing ever succeeded", () => {
    const plan = rollbackPlan([dep("r:v1", "failed", 1), dep("r:v1", "running", 2)], "");
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/No deployment of this app has succeeded/);
  });
  it("compares refs as written, like the agent: a digest and a tag of one image differ", () => {
    const plan = rollbackPlan([dep(`r@sha256:${"a".repeat(64)}`, "succeeded", 2)], "r:v1");
    expect(plan.ok).toBe(true);
  });
});

describe("recentVersions", () => {
  it("lists each successfully deployed ref once, newest first, marking the serving one", () => {
    expect(recentVersions(history, "r:v3")).toEqual([
      { ref: "r:v3", at: "2026-10-20T10:30:00Z", serving: true },
      { ref: "r:v2", at: "2026-10-20T10:10:00Z", serving: false },
      { ref: "r:v1", at: "2026-10-20T10:05:00Z", serving: false },
    ]);
  });
  it("is empty without a success, and capped", () => {
    expect(recentVersions([dep("r:v1", "failed", 1)], "")).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => dep(`r:v${i}`, "succeeded", i));
    expect(recentVersions(many, "", 4)).toHaveLength(4);
  });
});

describe("deployChange", () => {
  it("says from which version to which", async () => {
    const { deployChange } = await import("@/lib/rollback-core");
    expect(deployChange("r/web:v2", "v3")).toEqual({ from: "v2", to: "v3", same: false });
    expect(deployChange("", "v3")).toEqual({ from: "", to: "v3", same: false });
  });
  it("notices that the version already serves, by tag or by digest, and shortens a typed digest", async () => {
    const { deployChange } = await import("@/lib/rollback-core");
    expect(deployChange("r/web:v2", " v2 ").same).toBe(true);
    const d = `sha256:${"e".repeat(64)}`;
    expect(deployChange(`r/web@${d}`, d)).toEqual({ from: "eeeeeeeeeeee", to: "eeeeeeeeeeee", same: true });
  });
});
