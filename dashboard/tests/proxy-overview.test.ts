import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { ProxyRoute, ProxyView } from "@/lib/agent-types";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-proxy-overview-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ProxyOverview } = await import("@/components/servers/ProxyOverview");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const route = (over: Partial<ProxyRoute>): ProxyRoute => ({
  kind: "app",
  app: "web",
  domains: ["web.example.com"],
  upstream: "127.0.0.1:41000",
  container: "web-0123456789abcdef",
  ref: "ghcr.io/acme/web:0123456789abcdef0123456789abcdef01234567",
  updated_at: "2026-10-22T10:00:00Z",
  running: true,
  ...over,
});

async function render(routes: ProxyRoute[]): Promise<string> {
  const view: ProxyView = { type: "caddy", where: "http://127.0.0.1:2019", generated: "{}", in_sync: true, routes, unrouted: [] };
  const element = await ProxyOverview({ serverId: "srv", proxy: Promise.resolve({ data: view }) });
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement("div", null, element)));
}

describe("the proxy view", () => {
  it("shows a site by its first host and what it serves, not as a stopped app", async () => {
    const html = await render([
      route({}),
      route({ kind: "site", app: "", domains: ["www.example.com", "example.com"], site_kind: "static", target: "/var/www/example.com", upstream: "", container: "", ref: "", updated_at: "0001-01-01T00:00:00Z", running: false }),
    ]);
    expect(html).toContain("www.example.com");
    expect(html).toContain("static, also example.com");
    expect(html).toContain("/var/www/example.com");
    expect(html).toContain("Site");
    // The one app still reads as running; the site is not reported as "Not running".
    expect(html.match(/Not running/g) ?? []).toHaveLength(0);
    expect(html).toContain("web.example.com");
  });

  it("lists two sites that serve different hosts without a key clash", async () => {
    const site = (host: string): ProxyRoute =>
      route({ kind: "site", app: "", domains: [host], site_kind: "redirect", target: `301 https://${host}/`, upstream: "", container: "", ref: "", running: false });
    const html = await render([site("a.example.com"), site("b.example.com")]);
    expect(html).toContain("a.example.com");
    expect(html).toContain("b.example.com");
  });
});

describe("the domains of the proxy view", () => {
  it("lists every domain of every app and site with its live checks, once each", async () => {
    const html = await render([
      route({ domains: ["web.example.com", "www.web.example.com"] }),
      route({ kind: "site", app: "", domains: ["static.example.com", "web.example.com"], site_kind: "static", target: "/var/www", upstream: "", container: "", ref: "", running: false }),
    ]);
    expect(html).toContain('data-testid="domains-card"');
    for (const host of ["web.example.com", "www.web.example.com", "static.example.com"]) expect(html).toContain(`data-domain="${host}"`);
    expect(html.match(/data-domain="web.example.com"/g)).toHaveLength(1);
    expect(html.match(/Re-check/g)).toHaveLength(3);
  });

  it("has no domains card for routes without a domain", async () => {
    const html = await render([route({ domains: [] })]);
    expect(html).not.toContain("domains-card");
  });
});
