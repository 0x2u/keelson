import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigVersion } from "@/lib/agent-types";
import { reviewChanges } from "@/lib/app-config-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-config-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {}, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

// Dynamic imports: the data directory above must be set before the modules that open the database are loaded.
const { AppChangesList, AppReviewBody } = await import("@/components/config/AppReviewDialog");
const { ConfigChangedNotice } = await import("@/components/config/ConfigChangedBadge");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const app: AppConfig = { name: "web", image: "ghcr.io/acme/web", env: { TOKEN: "<hidden>" }, port: 3000, domains: ["web.example.com"] };

describe("the review of an app's changes", () => {
  it("shows each changed field with its old and new value and what it means (redeploy, live)", () => {
    const html = render(createElement(AppChangesList, { changes: reviewChanges(app, { ...app, port: 3001, domains: ["b.example.com"] }) }));
    expect(html).toContain("app port");
    expect(html).toContain("3000");
    expect(html).toContain("3001");
    expect(html).toContain("Needs a deploy");
    expect(html).toContain("Applied live");
    expect(html).toContain("b.example.com");
  });
  it("never prints an environment value, only that the variable changed", () => {
    const html = render(createElement(AppChangesList, { changes: reviewChanges(app, { ...app, env: { TOKEN: "hunter2-secret", NEW: "another-secret" } }) }));
    expect(html).toContain("TOKEN");
    expect(html).toContain("value changed");
    expect(html).toContain("NEW");
    expect(html).not.toContain("hunter2-secret");
    expect(html).not.toContain("another-secret");
  });
  it("says so when nothing changed", () => {
    expect(render(createElement(AppChangesList, { changes: [] }))).toContain("Nothing changed");
  });
  it("has Back and Confirm, and warns that the running version keeps its settings when something needs a redeploy", () => {
    const props = { creating: false, pending: false, onBack: () => {}, onConfirm: () => {} };
    const html = render(createElement(AppReviewBody, { ...props, changes: reviewChanges(app, { ...app, port: 1 }) }));
    expect(html).toContain("Back");
    expect(html).toContain("Confirm and save");
    expect(html).toContain("keeps its settings until you deploy");
    expect(render(createElement(AppReviewBody, { ...props, changes: reviewChanges(app, { ...app, domains: ["b.example.com"] }) }))).not.toContain("until you redeploy");
    expect(render(createElement(AppReviewBody, { ...props, pending: true, changes: [] }))).toContain("Saving…");
  });
});

describe("the config changed badge", () => {
  const since = {
    deployedAt: "2026-10-20T10:00:00Z",
    then: { id: 2, at: "2026-10-20T09:00:00Z", hash: "b", source: "api" } satisfies ConfigVersion,
    now: { id: 3, at: "2026-10-20T12:00:00Z", hash: "c", source: "api" } satisfies ConfigVersion,
  };
  it("says the configuration changed since the running version and links to the versions", () => {
    const html = render(createElement(ConfigChangedNotice, { serverId: "s1", since }));
    expect(html).toContain("Config changed since the running version");
    expect(html).toContain('href="/servers/s1/config/versions"');
  });
});
