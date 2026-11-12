import { describe, expect, it } from "vitest";
import type { JobRun } from "@/lib/agent-types";
import { anyRunning, highlightedRun, latestRun, parseRowCounts, runAnchor } from "@/lib/run-core";

const run = (id: string, started_at: string, status: JobRun["status"] = "succeeded"): JobRun => ({ id, job: "j", trigger: "manual", status, started_at });

describe("run-core", () => {
  it("anchors a run by id, the same fragment the toast links to", () => {
    expect(runAnchor("r7")).toBe("run-r7");
  });
  it("reads the highlighted run from the query, first value, empty is none", () => {
    expect(highlightedRun("r7")).toBe("r7");
    expect(highlightedRun(["a", "b"])).toBe("a");
    expect(highlightedRun("")).toBeUndefined();
    expect(highlightedRun(undefined)).toBeUndefined();
  });
  it("parses the row counts a restore ends with", () => {
    const out = "created database shop_restore\nrestored\nrow counts (public schema, 2 tables): orders=7, users=42";
    expect(parseRowCounts(out)).toEqual({
      summary: "row counts (public schema, 2 tables)",
      tables: [
        { name: "orders", rows: 7 },
        { name: "users", rows: 42 },
      ],
    });
  });
  it("keeps the partial listing's own summary", () => {
    expect(parseRowCounts("row counts (public schema, first 1 of 9 tables): a=1\n")?.summary).toBe("row counts (public schema, first 1 of 9 tables)");
  });
  it("has no counts when the agent reports none", () => {
    expect(parseRowCounts(undefined)).toBeNull();
    expect(parseRowCounts("backup written\n")).toBeNull();
    expect(parseRowCounts("row counts unavailable: boom")).toBeNull();
    expect(parseRowCounts("row counts: no table in the public schema")).toBeNull();
  });
  it("finds the newest run whatever the order of the list", () => {
    expect(latestRun([run("a", "2026-01-01T00:00:00Z"), run("c", "2026-03-01T00:00:00Z"), run("b", "2026-02-01T00:00:00Z")])?.id).toBe("c");
    expect(latestRun([])).toBeUndefined();
    expect(latestRun(undefined)).toBeUndefined();
  });
  it("says when a run is still going in any list", () => {
    expect(anyRunning([run("a", "2026-01-01T00:00:00Z")], undefined)).toBe(false);
    expect(anyRunning([run("a", "2026-01-01T00:00:00Z")], [run("b", "2026-01-02T00:00:00Z", "running")])).toBe(true);
  });
});
