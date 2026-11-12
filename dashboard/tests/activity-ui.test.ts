import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildFeed, parseFilter, type ActivityEvent } from "@/lib/activity-core";
import { triggerLabel } from "@/lib/labels-core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ActivityRow, UnansweredRow } = await import("@/components/activity/ActivityRow");
const { ActivityFilters } = await import("@/components/activity/ActivityFilters");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

/** The links of some markup: the href, the text (without tags or React's text separators) and whether it is marked current. */
function links(out: string): { href: string; text: string; current: boolean }[] {
  return [...out.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1].replaceAll("&amp;", "&") ?? "",
    text: m[2].replace(/<!-- -->/g, "").replace(/<[^>]*>/g, ""),
    current: m[1].includes('aria-current="true"'),
  }));
}

const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "a:d:1",
  kind: "deployment",
  at: "2026-10-23T11:00:00Z",
  server: { id: "a", name: "prod" },
  tone: "success",
  status: "Succeeded",
  failed: false,
  summary: "Deployed web",
  subject: { label: "web", href: "/servers/a/apps/web" },
  href: "/servers/a/deployments/1",
  ...over,
});

describe("ActivityRow", () => {
  it("never cuts the tag of a long image reference: the tag is a chip next to the shortened repository", () => {
    const out = html(createElement(ActivityRow, { event: event({ ref: "registry.example.com/team/platform/services/checkout-api:v1.4.2" }) }));
    expect(out).toContain("…");
    expect(out).toContain(">v1.4.2<");
  });
  it("links the app inside the sentence, names the server, the trigger and who did it", () => {
    const out = html(createElement(ActivityRow, { event: event({ trigger: "GitHub webhook", actor: "token:ci" }) }));
    expect(out.replace(/<!-- -->/g, "")).toMatch(/Deployed <a [^>]*href="\/servers\/a\/apps\/web"[^>]*>web<\/a>/);
    expect(links(out)).toEqual(expect.arrayContaining([{ href: "/servers/a", text: "prod", current: false }]));
    expect(out).toContain("GitHub webhook");
    expect(out).toContain("by token:ci");
    expect(out).toContain('aria-label="Open: Deployed web on prod"');
    expect(out).toContain("Succeeded");
  });
  it("marks a failed row and shows its error line", () => {
    const out = html(createElement(ActivityRow, { event: event({ tone: "danger", status: "Failed", failed: true, summary: "Deploy of web failed", note: "health check failed" }) }));
    expect(out).toContain('data-failed="true"');
    expect(out).toContain("border-l-destructive");
    expect(out).toContain("health check failed");
  });
  it("links the output of a run, and says what kind of event it is for assistive technology", () => {
    const out = html(createElement(ActivityRow, { event: event({ kind: "job", summary: "Job ping failed", subject: undefined, outputHref: "/servers/a/jobs/ping?run=r1#run-r1" }) }));
    expect(out).toContain('href="/servers/a/jobs/ping?run=r1#run-r1"');
    expect(out).toContain("Output");
    expect(out).toContain('<span class="sr-only">Job</span>');
  });
  it("shows a dashboard-level event without a server link", () => {
    const out = html(createElement(ActivityRow, { event: event({ server: undefined, kind: "security", summary: "Signed in", subject: undefined, href: "/settings/security" }) }));
    expect(out).toContain(">Dashboard<");
    expect(links(out).some((l) => l.href === "/servers/a")).toBe(false);
  });
  it("has the absolute time on hover and keyboard focus (a focusable time with a tooltip)", () => {
    expect(html(createElement(ActivityRow, { event: event() }))).toMatch(/<time dateTime="2026-10-23T11:00:00Z" tabindex="0"[^>]*data-state="closed"/);
  });
});

describe("UnansweredRow", () => {
  it("says it cannot tell, by server and reason, and links to the server", () => {
    const out = html(createElement(UnansweredRow, { server: { id: "b", name: "edge", reason: "cannot reach the agent: connection refused" } }));
    expect(out).toContain("Can&#x27;t tell: edge did not answer (cannot reach the agent: connection refused)");
    expect(out).toContain('href="/servers/b"');
  });
});

describe("ActivityFilters", () => {
  const options = buildFeed({ servers: [], dashboard: [], now: 0, filter: parseFilter({}), trigger: triggerLabel }).options;
  const render = (query: Record<string, string>) =>
    html(createElement(ActivityFilters, { filter: parseFilter(query), options: { ...options, servers: [{ id: "a", name: "prod" }], projects: ["shop"], apps: ["web"] } }));

  it("offers every kind as a link that keeps the other filters", () => {
    const out = render({ failed: "1", window: "24h" });
    const hrefs = links(out).map((l) => l.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/activity?kind=deployment&failed=1&window=24h", "/activity?kind=security&failed=1&window=24h", "/activity?kind=backup&failed=1&window=24h"]));
    expect(links(out).map((l) => l.text)).toEqual(expect.arrayContaining(["Deployments", "Jobs", "Backups", "Config changes", "Security"]));
    // A window chip keeps the kind and the failed filter; "7 d" is the default, so it leaves the window out.
    expect(links(render({ kind: "job", failed: "1" })).find((l) => l.text === "7 d")?.href).toBe("/activity?kind=job&failed=1");
  });
  it("marks what is on, and the failed-only chip turns it off again", () => {
    const on = links(render({ failed: "1", kind: "job" }));
    expect(on.find((l) => l.text === "Jobs")).toEqual({ href: "/activity?kind=job&failed=1", text: "Jobs", current: true });
    expect(on.find((l) => l.text === "Failed only")).toEqual({ href: "/activity?kind=job", text: "Failed only", current: true });
    expect(on.find((l) => l.text === "All")).toEqual({ href: "/activity?failed=1", text: "All", current: false });
    expect(links(render({})).find((l) => l.text === "Failed only")).toEqual({ href: "/activity?failed=1", text: "Failed only", current: false });
  });
  it("lists servers, projects and apps to choose from, and the three windows", () => {
    const out = render({ server: "a", project: "shop" });
    expect(out).toContain('<option value="a" selected="">prod</option>');
    expect(out).toContain('<option value="project:shop" selected="">shop</option>');
    expect(out).toContain('<option value="app:web">web</option>');
    for (const label of [">1 h<", ">24 h<", ">7 d<"]) expect(out).toContain(label);
  });
});
