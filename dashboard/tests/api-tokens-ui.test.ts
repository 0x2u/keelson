import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-tokens-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const tokens = await import("@/lib/api-tokens");
const servers = await import("@/lib/servers");
const { ApiTokensSection } = await import("@/components/security/ApiTokensSection");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.now();

describe("the API tokens list", () => {
  it("shows name, prefix, scope, servers, expiry, last use with its address and status, and never a secret", () => {
    const a = servers.createServer({ name: "prod", url: "https://a.example.com", token: "t".repeat(40) });
    const live = tokens.createApiToken({ name: "claude", scope: "deploy", servers: [a], days: 30 }, NOW);
    const old = tokens.createApiToken({ name: "old-script", scope: "read", servers: null, days: 1 }, NOW - 3 * 24 * 60 * 60 * 1000);
    const gone = tokens.createApiToken({ name: "leaked", scope: "read", servers: null, days: 30 }, NOW);
    tokens.revokeApiToken(gone.record.id, NOW);
    tokens.touchApiToken(live.record.id, "203.0.113.9", NOW);

    const html = renderToStaticMarkup(
      createElement(ApiTokensSection, { tokens: tokens.listApiTokensWithStatus(NOW), servers: [{ id: a, name: "prod" }], origin: "https://keelson.example.com" }),
    );
    for (const text of ["API tokens", "claude", live.record.prefix, "deploy", "prod", "203.0.113.9", "old-script", "All servers", "Active", "Expired", "Revoked", "Create a token"]) {
      expect(html, text).toContain(text);
    }
    for (const t of [live, old, gone]) expect(html).not.toContain(t.token.slice(8));
    // Only a token that is not revoked can be revoked.
    expect(html.match(/aria-label="Revoke token [^"]*"/g)).toHaveLength(2);
  });

  it("shows a revoked token as Revoked with its time in the Expires column, not as expiring just now", () => {
    const gone = tokens.createApiToken({ name: "leaked", scope: "read", servers: null, days: 30 }, NOW);
    tokens.revokeApiToken(gone.record.id, NOW);
    const html = renderToStaticMarkup(
      createElement(ApiTokensSection, { tokens: tokens.listApiTokensWithStatus(NOW).filter((t) => t.id === gone.record.id), servers: [], origin: null }),
    );
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    expect(cells[4]).toMatch(/^Revoked\b/);
    expect(cells[4]).not.toMatch(/^just now|^in /);
  });

  it("says so when there is no token yet", () => {
    expect(renderToStaticMarkup(createElement(ApiTokensSection, { tokens: [], servers: [], origin: null }))).toContain("No API token yet");
  });
});
