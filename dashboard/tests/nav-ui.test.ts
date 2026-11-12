import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabView } from "@/lib/nav-core";

let pathname = "/";
let owner: string | null = null;
let health: { name: string; tone: string; label: string }[] = [];
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/actions", () => ({ logout: async () => {} }));
vi.mock("@/components/shell/use-fleet-health", () => ({ useFleetHealth: () => ({ servers: {}, projects: health }) }));
vi.mock("@/components/shell/shell-owner", () => ({ useShellOwner: () => owner }));

const { AppSidebar } = await import("@/components/shell/app-sidebar");
const { ServerTabs } = await import("@/components/servers/ServerTabs");
const { SidebarProvider } = await import("@/components/ui/sidebar");

const SERVERS = [
  { id: "s1", name: "vps-1" },
  { id: "s2", name: "vps-2" },
];

function sidebar(path: string): string {
  pathname = path;
  return renderToStaticMarkup(createElement(SidebarProvider, null, createElement(AppSidebar, { servers: SERVERS, version: "v0.1.0" })));
}

/** The labels of the entries the sidebar lights (data-active), in order. */
function lit(html: string): string[] {
  return [...html.matchAll(/<a [^>]*data-active="true"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

beforeEach(() => {
  pathname = "/";
  owner = null;
  health = [];
});

describe("the sidebar", () => {
  it("has Home, Projects, Servers (with its server list and Add server), Activity and, in the footer, Settings: no Databases and no Jobs", () => {
    const html = sidebar("/");
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/", "/", "/projects", "/projects/new", "/servers", "/servers/s1", "/servers/s2", "/servers/new", "/activity", "/settings"]);
    expect(html).toContain("vps-1");
    expect(html).toContain("Hide the server list");
    expect(html).toContain("Hide the project list");
  });

  it("says which version of Keelson this is, as text and not as a link", () => {
    const html = sidebar("/");
    expect(html).toContain("Keelson v0.1.0");
    expect(html).not.toMatch(/<a [^>]*>[^<]*v0\.1\.0/);
  });

  it("lights Home on / and nothing else", () => {
    expect(lit(sidebar("/"))).toEqual(["Home"]);
  });

  it.each([
    ["/projects", "Projects"],
    ["/projects/new", "New project"],
    ["/servers", "Servers"],
    ["/databases", "Home"],
    ["/jobs", "Home"],
    ["/activity", "Activity"],
    ["/settings", "Settings"],
    ["/settings/security", "Settings"],
    ["/settings/api-tokens", "Settings"],
    ["/settings/integrations", "Settings"],
    ["/settings/notifications", "Settings"],
  ])("lights exactly %s -> %s", (path, label) => {
    expect(lit(sidebar(path))).toEqual([label]);
  });

  it("lights the server, not the Servers entry, on every page of that server", () => {
    for (const path of ["/servers/s2", "/servers/s2/containers", "/servers/s2/databases/main", "/servers/s2/jobs/nightly", "/servers/s2/config/jobs/new", "/servers/s2/apps/shop"]) {
      expect(lit(sidebar(path)), path).toEqual(["vps-2Status unknown"]);
    }
  });

  it("lights the Projects entry, not a server, on a project's pages while the project list has not arrived", () => {
    // The list is filled by the live health call after the page loaded: until then (and with the list folded away) the entry stands for the place.
    expect(lit(sidebar("/projects/shop/jobs"))).toEqual([]);
  });

  it("lights Add server on the enrolment page and neither a server nor the list", () => {
    expect(lit(sidebar("/servers/new"))).toEqual(["Add server"]);
  });

  it("lists the projects under Projects with a status dot each, and lights the one the path is on", () => {
    health = [
      { name: "shop", tone: "success", label: "Running" },
      { name: "blog", tone: "danger", label: "Down" },
    ];
    const html = sidebar("/projects/shop/jobs");
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.slice(2, 6)).toEqual(["/projects", "/projects/shop", "/projects/blog", "/projects/new"]);
    // The dot's meaning is in text too (never the colour alone).
    expect(html.match(/<span class="sr-only">(Running|Down)<\/span>/g)).toHaveLength(2);
    expect(lit(html)).toEqual(["shopRunning"]);
  });

  it("lights the owning project, not the server, on the page of an entity that project owns", () => {
    health = [{ name: "shop", tone: "success", label: "Running" }];
    owner = "shop";
    const html = sidebar("/servers/s2/apps/shop");
    expect(lit(html)).toEqual(["shopRunning"]);
  });
});

const TABS: TabView[] = [
  { id: "overview", label: "Overview", href: "/servers/s1" },
  { id: "containers", label: "Containers", href: "/servers/s1/containers", count: 3, attention: { tone: "danger", count: 2, label: "2 things need attention" } },
  { id: "proxy", label: "Proxy", href: "/servers/s1/proxy", count: 1 },
];

function tabs(path: string): string {
  pathname = path;
  return renderToStaticMarkup(createElement(ServerTabs, { serverId: "s1", tabs: TABS }));
}

describe("the server's tab bar", () => {
  it("links each tab to its route and marks only the one you are on as the current page", () => {
    const html = tabs("/servers/s1/proxy");
    expect(html).toContain('href="/servers/s1"');
    expect(html).toContain('href="/servers/s1/containers"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*aria-current="page"[^>]*>Proxy/);
  });

  it("marks Overview on the server's own path", () => {
    expect(tabs("/servers/s1")).toMatch(/<a [^>]*aria-current="page"[^>]*>Overview/);
  });

  it("marks no tab on a page of the server that has none (an app)", () => {
    expect(tabs("/servers/s1/apps/shop")).not.toContain("aria-current");
  });

  it("shows the counts and a dot with a text for screen readers where the attention model has items", () => {
    const html = tabs("/servers/s1");
    expect(html).toMatch(/Containers<span[^>]*>3<\/span>/);
    expect(html).toContain("2 things need attention");
    expect(html.match(/sr-only/g)).toHaveLength(1);
    expect(html).toContain("bg-destructive");
  });

  it("is a labelled navigation that scrolls sideways instead of clipping its labels", () => {
    const html = tabs("/servers/s1");
    expect(html).toContain('aria-label="Server sections"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("shrink-0");
  });
});
