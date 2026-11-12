import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobRun } from "@/lib/agent-types";
import { JobRunList } from "@/components/JobRunList";
import { LatestRuns } from "@/components/databases/LatestRuns";

const run = (over: Partial<JobRun>): JobRun => ({ id: "r1", job: "backup-shop", trigger: "manual", status: "succeeded", started_at: "2026-01-01T10:00:00Z", finished_at: "2026-01-01T10:01:00Z", ...over });
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the list of runs", () => {
  it("gives each run an anchor and writes the trigger in words", () => {
    const html = render(createElement(JobRunList, { runs: [run({ id: "r1" }), run({ id: "r2", trigger: "schedule" })] }));
    expect(html).toContain('id="run-r1"');
    expect(html).toContain('id="run-r2"');
    expect(html).toContain("Run now");
    expect(html).toContain("Schedule");
    expect(html).not.toContain(">manual<");
  });
  it("marks the run of the toast and opens its output", () => {
    const html = render(createElement(JobRunList, { runs: [run({ id: "r1", output: "first" }), run({ id: "r2", output: "second" })], highlight: "r2" }));
    expect(html).toMatch(/id="run-r2"[^>]*data-highlighted/);
    expect(html).not.toMatch(/id="run-r1"[^>]*data-highlighted/);
    expect(html).toContain("second");
    expect(html).not.toContain("first");
  });
});

describe("the latest backup and restore at the top of the database page", () => {
  it("shows status, row counts and a link to the full output of a restore", () => {
    const restore = run({ id: "r9", output: "restored\nrow counts (public schema, 2 tables): orders=7, users=1234" });
    const html = render(createElement(LatestRuns, { restore }));
    expect(html).toContain("Latest restore");
    expect(html).toContain("row counts (public schema, 2 tables)");
    expect(html).toContain("orders");
    expect(html).toContain("1,234");
    expect(html).toContain("?run=r9#run-r9");
    expect(html).not.toContain("Latest backup");
  });
  it("shows a failed backup's reason and nothing when neither has run", () => {
    const html = render(createElement(LatestRuns, { backup: run({ status: "failed", detail: "destination unreachable" }) }));
    expect(html).toContain("Latest backup");
    expect(html).toContain("destination unreachable");
    expect(render(createElement(LatestRuns, {}))).toBe("");
  });
});
