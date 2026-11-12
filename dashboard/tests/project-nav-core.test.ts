import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSummaryCards, summaryCards } from "@/components/projects/ProjectSummaryCards";
import type { HubSummary } from "@/lib/project-hub-core";
import { activeNav, activeProjectTab, projectTabs, safeReturnPath } from "@/lib/nav-core";

describe("projectTabs", () => {
  it("lists the nine tabs in order, the overview at the project's own address", () => {
    const tabs = projectTabs("shop");
    expect(tabs.map((t) => t.id)).toEqual(["overview", "apps", "jobs", "databases", "domains", "variables", "source", "readiness", "config"]);
    expect(tabs.map((t) => t.href)).toEqual(["/projects/shop", "/projects/shop/apps", "/projects/shop/jobs", "/projects/shop/databases", "/projects/shop/domains", "/projects/shop/variables", "/projects/shop/source", "/projects/shop/readiness", "/projects/shop/config"]);
    expect(tabs.find((t) => t.id === "config")?.label).toBe("Configuration");
  });

  it("carries a count only where given (zero is a count) and a dot only where asked", () => {
    const tabs = projectTabs("shop", { jobs: 0, databases: 2 }, ["jobs"]);
    expect(tabs.find((t) => t.id === "jobs")).toMatchObject({ count: 0, attention: true });
    expect(tabs.find((t) => t.id === "databases")).toMatchObject({ count: 2 });
    expect(tabs.find((t) => t.id === "databases")).not.toHaveProperty("attention");
    expect(tabs.find((t) => t.id === "apps")).not.toHaveProperty("count");
  });

  it("encodes the project name in the hrefs", () => {
    expect(projectTabs("a b")[1].href).toBe("/projects/a%20b/apps");
  });
});

describe("activeProjectTab", () => {
  it("is the overview at the project's address, with a trailing slash, and for unknown sub-paths", () => {
    expect(activeProjectTab("/projects/shop", "shop")).toBe("overview");
    expect(activeProjectTab("/projects/shop/", "shop")).toBe("overview");
    expect(activeProjectTab("/projects/shop/unknown", "shop")).toBe("overview");
  });

  it("finds the tab of a path, and of a page nested under it", () => {
    expect(activeProjectTab("/projects/shop/jobs", "shop")).toBe("jobs");
    expect(activeProjectTab("/projects/shop/config", "shop")).toBe("config");
    expect(activeProjectTab("/projects/shop/databases/anything", "shop")).toBe("databases");
  });

  it("does not take another project's path, and reads an encoded name", () => {
    expect(activeProjectTab("/projects/shop2/jobs", "shop")).toBe("overview");
    expect(activeProjectTab("/projects/a%20b/domains", "a b")).toBe("domains");
  });

  it("keeps every tab under the Projects entry of the sidebar", () => {
    for (const t of projectTabs("shop")) expect(activeNav(t.href)).toBe(activeNav("/projects"));
  });
});

describe("safeReturnPath", () => {
  it("accepts a path of a project, with its query", () => {
    expect(safeReturnPath("/projects/shop/jobs")).toBe("/projects/shop/jobs");
    expect(safeReturnPath("/projects/a%20b/databases?x=1")).toBe("/projects/a%20b/databases?x=1");
  });

  it.each([
    undefined,
    "",
    "/",
    "/servers/s1",
    "projects/shop",
    "https://evil.example/projects/x",
    "//evil.example/projects/x",
    "/projects//evil.example",
    "/projects/\\evil.example",
    "/projects/../servers",
    "/projects/shop/%2e%2e/x",
    "/projects/%2F%2Fevil",
    "/projects/shop\n/x",
    "/projects/%E0%A4%A",
    "/projects/" + "a".repeat(600),
    "javascript:alert(1)",
    "/projectsx",
  ])("refuses %j", (from) => {
    expect(safeReturnPath(from)).toBeNull();
  });

  it("refuses a repeated parameter", () => {
    expect(safeReturnPath(["/projects/a", "/projects/b"])).toBeNull();
  });
});

describe("the overview's cards", () => {
  const zero: HubSummary = { apps: { count: 0, down: 0 }, jobs: { count: 0, failing: 0, neverRun: 0, paused: 0, look: 0 }, databases: { count: 0, failed: 0, overdue: 0, unprotected: 0, pending: 0, look: 0 }, domains: { count: 0 } };
  const hrefs = Object.fromEntries(projectTabs("shop").map((t) => [t.id, t.href]));

  it("say what an empty section is, and that there may be more when a server did not answer", () => {
    const cards = summaryCards(zero, true);
    expect(cards.map((c) => c.id)).toEqual(["apps", "jobs", "databases", "domains"]);
    expect(cards.find((c) => c.id === "jobs")?.line).toContain("may be more");
    expect(summaryCards(zero, false).find((c) => c.id === "jobs")?.line).toBe("No scheduled job");
  });

  it("name the cause: failing jobs, a failed backup, an app down", () => {
    const cards = summaryCards({ apps: { count: 2, down: 1 }, jobs: { count: 4, failing: 1, neverRun: 1, paused: 1, look: 2 }, databases: { count: 3, failed: 1, overdue: 1, unprotected: 1, pending: 0, look: 3 }, domains: { count: 1 } }, false);
    expect(cards.map((c) => [c.tone, c.line])).toEqual([
      ["danger", "1 down"],
      ["danger", "1 failing, 1 never run, 1 paused"],
      ["danger", "1 with a failed backup, 1 overdue or never scheduled, 1 without a running backup schedule"],
      ["success", "1 hostname"],
    ]);
  });

  it("never say healthy for jobs that never ran, nor backed up for a database waiting for its first backup", () => {
    const cards = summaryCards({ ...zero, jobs: { count: 2, failing: 0, neverRun: 2, paused: 0, look: 2 }, databases: { count: 1, failed: 0, overdue: 0, unprotected: 0, pending: 1, look: 0 } }, false);
    const jobs = cards.find((c) => c.id === "jobs");
    const dbs = cards.find((c) => c.id === "databases");
    expect(jobs).toMatchObject({ tone: "warning", line: "2 never run" });
    expect(dbs).toMatchObject({ tone: "info", line: "1 waiting for the first backup" });
  });

  it("say healthy only when every job and database is", () => {
    const cards = summaryCards({ ...zero, jobs: { count: 2, failing: 0, neverRun: 0, paused: 0, look: 0 }, databases: { count: 1, failed: 0, overdue: 0, unprotected: 0, pending: 0, look: 0 } }, false);
    expect([cards[1].line, cards[2].line]).toEqual(["All healthy", "Backed up"]);
  });

  it("render a link to each tab with its count", () => {
    const html = renderToStaticMarkup(createElement(ProjectSummaryCards, { summary: { ...zero, apps: { count: 2, down: 0 }, domains: { count: 3 } }, hrefs, unanswered: false }));
    for (const t of ["apps", "jobs", "databases", "domains"]) expect(html).toContain(`href="${hrefs[t]}"`);
    expect(html).toContain("All up");
    expect(html).toContain("3 hostnames");
  });
});
