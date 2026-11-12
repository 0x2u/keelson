import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Preview } from "@/lib/agent-types";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-previews-card-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// The card's buttons call server actions; rendering never runs them.
vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "local" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const { PreviewsCard } = await import("@/components/repository/PreviewsCard");
const deliveries = await import("@/lib/webhook-deliveries");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db().exec("DELETE FROM webhook_deliveries"));

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

const preview = (over: Partial<Preview> = {}): Preview => ({
  name: "shop-pr-12",
  app: "shop",
  pr: 12,
  domain: "pr-12-shop.example.com",
  url: "https://pr-12-shop.example.com",
  ref: `ghcr.io/acme/shop:${SHA}`,
  status: "running",
  deployment_id: "dep-9",
  created_at: "2026-10-21T10:00:00Z",
  updated_at: "2026-10-21T10:05:00Z",
  expires_at: "2026-10-24T10:05:00Z",
  ...over,
});

function render(previews: Parameters<typeof PreviewsCard>[0]["previews"], over: Partial<Parameters<typeof PreviewsCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PreviewsCard, { serverId: "srv-1", app: "shop", workflow: "Build and push", suggestions: ["Build and push"], secretSet: true, canDeploy: true, previews, ...over }),
  );
}

describe("the previews card", () => {
  it("lists the live instances of the app: pull request, address link, status, commit, deployment link and a delete button", () => {
    const html = render({ data: [preview(), preview({ name: "shop-pr-13", pr: 13, domain: "pr-13-shop.example.com", url: "https://pr-13-shop.example.com", status: "deploying", ref: `x:${"c".repeat(40)}` })] });
    expect(html).toContain("#12");
    expect(html).toContain("shop-pr-12");
    expect(html).toContain('href="https://pr-12-shop.example.com"');
    expect(html).toContain(">pr-12-shop.example.com<");
    expect(html).toContain("Running");
    expect(html).toContain("Deploying");
    expect(html).toContain("abcdef0");
    expect(html).toContain("ccccccc");
    expect(html).toContain('href="/servers/srv-1/deployments/dep-9"');
    expect(html).toContain('aria-label="Delete shop-pr-12"');
    expect(html).toContain('aria-label="Delete shop-pr-13"');
    expect(html).toContain('dateTime="2026-10-24T10:05:00Z"');
  });

  it("shows a failed instance as failed", () => {
    expect(render({ data: [preview({ status: "failed" })] })).toContain("Failed");
  });

  it("leaves out the instances of other apps", () => {
    const html = render({ data: [preview({ name: "admin-pr-4", app: "admin", pr: 4 }), preview()] });
    expect(html).not.toContain("admin-pr-4");
    expect(html).toContain("shop-pr-12");
  });

  it("does not link an address that is not https", () => {
    const html = render({ data: [preview({ url: "javascript:alert(1)", domain: "pr-12-shop.example.com" })] });
    expect(html).not.toContain("href=\"javascript:");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("pr-12-shop.example.com");
  });

  it("says there are none, that the agent is too old, or why the list could not be read", () => {
    expect(render({ data: [] })).toContain('data-slot="empty-state"');
    expect(render({ data: null })).toContain("This server&#x27;s agent has no previews");
    expect(render({ error: "cannot reach the agent: connection refused" })).toContain("cannot reach the agent: connection refused");
  });

  it("shows the switch with its workflow, and warns about a missing webhook secret and deploy secret", () => {
    const html = render({ data: [] }, { secretSet: false, canDeploy: false });
    expect(html).toContain('value="Build and push"');
    expect(html).toContain("The GitHub webhook is not set up");
    expect(html).toContain("This server cannot deploy from here");
    expect(render({ data: [] })).not.toContain("The GitHub webhook is not set up");
  });

  it("lists the latest preview deliveries of the app, and not the app's own", () => {
    const base = { repo: "acme/shop", branch: "feature", sha: SHA, serverId: "srv-1", outcome: "deployed" as const, detail: "preview deployment started", deploymentId: "dep-9" };
    deliveries.recordDelivery({ ...base, deliveryId: "d1", app: "shop-pr-12" });
    deliveries.recordDelivery({ ...base, deliveryId: "d2", app: "shop", detail: "production deploy" });
    deliveries.recordDelivery({ ...base, deliveryId: "d3", app: "shop-pr-13", outcome: "failed", detail: "a deployment is already running", deploymentId: null });
    deliveries.recordDelivery({ ...base, deliveryId: "d4", app: "shop-pr-feature", detail: "not a preview" });
    deliveries.recordDelivery({ ...base, deliveryId: "d5", app: "shop-pr-9", serverId: "srv-2", detail: "another server" });
    const html = render({ data: [] });
    expect(html).toContain("preview deployment started");
    expect(html).toContain("a deployment is already running");
    expect(html).not.toContain("production deploy");
    expect(html).not.toContain("not a preview");
    expect(html).not.toContain("another server");
    expect(render({ data: [] })).not.toContain("Nothing received yet");
  });

  it("says so when no delivery was received", () => {
    expect(render({ data: [] })).toContain('data-slot="empty-state"');
  });
});
