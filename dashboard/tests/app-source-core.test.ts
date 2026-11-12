import { describe, expect, it } from "vitest";
import { deployBlock, githubUrl, servingSentence, servingState, workflowNames } from "@/lib/app-source-core";

describe("githubUrl", () => {
  it("keeps only addresses that go to GitHub", () => {
    expect(githubUrl("https://github.com/acme/shop/commit/abc")).toBe("https://github.com/acme/shop/commit/abc");
    expect(githubUrl("https://evil.example.com/https://github.com/")).toBeNull();
    expect(githubUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("deployBlock", () => {
  const ok = { canDeploy: true, deploying: false, serving: false, ci: "success" as const };
  it("allows a commit whose CI passed, or has no run", () => {
    expect(deployBlock(ok)).toBeNull();
    expect(deployBlock({ ...ok, ci: null })).toBeNull();
  });
  it("names the reason, read-only first", () => {
    expect(deployBlock({ ...ok, canDeploy: false, deploying: true })).toContain("read-only");
    expect(deployBlock({ ...ok, deploying: true })).toContain("deployment is running");
    expect(deployBlock({ ...ok, serving: true })).toContain("already serving");
    expect(deployBlock({ ...ok, ci: "failure" })).toContain("CI has not passed");
  });
});

describe("workflowNames", () => {
  it("lists each name once and drops empty ones", () => {
    expect(workflowNames([{ name: "CI" }, { name: "" }, { name: "Release" }, { name: "CI" }])).toEqual(["CI", "Release"]);
  });
});

describe("servingState and servingSentence", () => {
  it("tells nothing running, an untagged image, current, behind (singular and plural) and unknown", () => {
    expect(servingState(null, null, null)).toEqual({ kind: "nothing" });
    expect(servingState("shop:latest", null, null)).toEqual({ kind: "untagged" });
    expect(servingState("shop:abc", "abc", null)).toEqual({ kind: "unknown" });
    expect(servingState("shop:abc", "abc", 0)).toEqual({ kind: "current" });
    expect(servingState("shop:abc", "abc", 3)).toEqual({ kind: "behind", by: 3 });
    expect(servingSentence({ kind: "current" }, "main")).toBe("Up to date with main.");
    expect(servingSentence({ kind: "behind", by: 1 }, "main")).toBe("1 commit behind main.");
    expect(servingSentence({ kind: "behind", by: 3 }, "main")).toBe("3 commits behind main.");
    expect(servingSentence({ kind: "unknown" }, "main")).toBe("Could not compare it with main.");
    expect(servingSentence({ kind: "nothing" }, "main")).toBeNull();
  });
});
