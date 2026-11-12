import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigDocument } from "@/lib/agent-types";
import { dashboardBackupItem } from "@/lib/readiness-core";
import { backupStatus, cloudflareStatus, githubStatus, notificationChannels, notificationState, securityStatus, settingsCards, tokensStatus, type SettingsInput } from "@/lib/settings-core";

const { SettingsIndex } = await import("@/components/settings/SettingsIndex");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const backupItem = (lastBackupAt: number | null) => dashboardBackupItem(lastBackupAt, NOW);
const input = (over: Partial<SettingsInput> = {}): SettingsInput => ({ totp: true, passkeys: 2, tokens: ["active", "active", "expired", "revoked"], githubApp: { label: "keelson-acme" }, githubAccount: null, cloudflare: { expiresOn: "2027-01-01T00:00:00Z" }, backup: backupItem(NOW - 3 * 86_400_000), now: NOW, ...over });

const doc = (over: Partial<ConfigDocument> & { notifications?: NonNullable<ConfigDocument["model"]["notifications"]> } = {}): ConfigDocument => {
  const { notifications, ...rest } = over;
  return { content: "", hash: "h", modified_at: "", applied_hash: "h", deprecations: [], model: { apps: [], jobs: [], databases: [], ...(notifications ? { notifications } : {}) } as never, ...rest };
};

describe("the one-line status of each settings section", () => {
  it("says what protects the dashboard", () => {
    expect(securityStatus(true, 2)).toEqual({ tone: "success", label: "2FA on: an authenticator app and 2 passkeys" });
    expect(securityStatus(false, 1).label).toBe("2FA on: 1 passkey");
    expect(securityStatus(true, 0).label).toBe("2FA on: an authenticator app");
    expect(securityStatus(false, 0)).toMatchObject({ tone: "warning", label: expect.stringContaining("2FA off") });
  });

  it("says whether a copy of the dashboard exists and whether it is out of date", () => {
    expect(backupStatus(backupItem(null), NOW)).toEqual({ tone: "warning", label: "No copy downloaded yet" });
    expect(backupStatus(backupItem(NOW - 3 * 86_400_000), NOW)).toEqual({ tone: "success", label: "Last copy downloaded 3 d ago" });
    expect(backupStatus(backupItem(NOW - 40 * 86_400_000), NOW)).toEqual({ tone: "warning", label: "Last copy downloaded 40 d ago: it is out of date" });
  });

  it("counts the tokens that work, apart from expired and revoked ones", () => {
    expect(tokensStatus(["active", "active", "expired", "revoked"])).toEqual({ tone: "success", label: "2 active tokens, 1 expired" });
    expect(tokensStatus(["active"]).label).toBe("1 active token");
    expect(tokensStatus(["expired"]).label).toBe("No active token (1 expired)");
    expect(tokensStatus([])).toEqual({ tone: "muted", label: "No API token" });
  });

  it("says whether GitHub is connected, as an App or as a personal token", () => {
    expect(githubStatus({ label: "keelson-acme" }, null).label).toBe("Connected: GitHub App keelson-acme");
    expect(githubStatus(null, "octo").label).toBe("Connected as octo (personal token)");
    expect(githubStatus(null, null)).toEqual({ tone: "muted", label: "Not connected" });
  });

  it("says whether Cloudflare is connected, with the token's expiry when known", () => {
    expect(cloudflareStatus({ expiresOn: "2027-01-01T00:00:00Z" }).label).toBe("Connected, token expires 2027-01-01");
    expect(cloudflareStatus({ expiresOn: null }).label).toBe("Connected");
    expect(cloudflareStatus(null)).toEqual({ tone: "muted", label: "Not connected" });
  });

  it("orders the cards Security, Backup, API tokens, GitHub, Cloudflare and links the integrations to their page", () => {
    const cards = settingsCards(input());
    expect(cards.map((c) => [c.id, c.href])).toEqual([
      ["security", "/settings/security"],
      ["backup", "/settings/backup"],
      ["api-tokens", "/settings/api-tokens"],
      ["github", "/settings/integrations"],
      ["cloudflare", "/settings/integrations"],
    ]);
  });
});

describe("a server's notifications", () => {
  it("lists the channels that are set", () => {
    expect(notificationChannels({ webhooks: [{ url: "https://a" }, { url: "https://b" }], telegram: { bot_token_file: "/t", chat_id: "1" }, heartbeat: { url: "https://h" } })).toEqual(["2 webhooks", "Telegram", "heartbeat"]);
    expect(notificationChannels({ events: ["deploy"] })).toEqual([]);
    expect(notificationChannels(undefined)).toEqual([]);
  });

  it("derives the state from what the agent answered", () => {
    expect(notificationState({ data: doc({ notifications: { heartbeat: { url: "https://h" } } }) })).toEqual({ kind: "configured", channels: ["heartbeat"] });
    expect(notificationState({ data: doc() })).toEqual({ kind: "none" });
    expect(notificationState({ data: null })).toEqual({ kind: "read-only" });
    expect(notificationState({ error: "connect ECONNREFUSED" })).toEqual({ kind: "unknown", reason: "connect ECONNREFUSED" });
    expect(notificationState({ data: doc({ error: "yaml: bad" }) })).toMatchObject({ kind: "unknown" });
  });
});

const render = (over: Partial<SettingsInput> = {}, notifications: Parameters<typeof SettingsIndex>[0]["notifications"] = [], about: Parameters<typeof SettingsIndex>[0]["about"] = { version: "v0.1.0", agent: "v0.1.0", releaseNotes: "https://github.com/0x2u/keelson/releases/tag/v0.1.0" }) =>
  renderToStaticMarkup(createElement(SettingsIndex, { cards: settingsCards(input(over)), notifications, about }));

describe("the settings index", () => {
  it("links every section and says where each stands when all is set up", () => {
    const html = render({}, [{ id: "s1", name: "alpha", state: { kind: "configured", channels: ["Telegram"] } }]);
    for (const href of ["/settings/security", "/settings/api-tokens", "/settings/integrations"]) expect(html).toContain(`href="${href}"`);
    expect(html).toContain("2FA on: an authenticator app and 2 passkeys");
    expect(html).toContain("2 active tokens, 1 expired");
    expect(html).toContain("Connected: GitHub App keelson-acme");
    expect(html).toContain("Connected, token expires 2027-01-01");
    expect(html).toContain('href="/servers/s1/config/notifications"');
    expect(html).toContain("Telegram");
  });

  it("warns when the dashboard has no second factor and nothing is connected", () => {
    const html = render({ totp: false, passkeys: 0, tokens: [], githubApp: null, cloudflare: null });
    expect(html).toContain("2FA off");
    expect(html).toContain("No API token");
    expect(html.match(/Not connected/g)).toHaveLength(2);
  });

  it("says it can't tell for a server whose configuration could not be read, instead of 'not configured'", () => {
    const html = render({}, [
      { id: "s1", name: "alpha", state: { kind: "none" } },
      { id: "s2", name: "beta", state: { kind: "unknown", reason: "connect ECONNREFUSED" } },
      { id: "s3", name: "gamma", state: { kind: "read-only" } },
    ]);
    expect(html).toContain("Not configured");
    expect(html).toContain("Can&#x27;t tell: connect ECONNREFUSED");
    expect(html).toContain("Read-only server");
    expect(html.match(/data-server=/g)).toHaveLength(3);
  });

  it("says which Keelson this is and what agent it carries, with the release notes only for a published tag", () => {
    const html = render();
    expect(html).toContain('data-testid="about"');
    expect(html).toContain("v0.1.0");
    expect(html).toContain('href="https://github.com/0x2u/keelson/releases/tag/v0.1.0"');
    const between = render({}, [], { version: "v0.1.0-4-gabc1234", agent: "v0.1.0-4-gabc1234", releaseNotes: null });
    expect(between).toContain("v0.1.0-4-gabc1234");
    expect(between).not.toContain("Release notes");
    expect(render({}, [], { version: "dev", agent: null, releaseNotes: null })).toContain("none");
  });

  it("explains the empty case of no server yet", () => {
    const html = render();
    expect(html).toContain('data-testid="notifications-empty"');
    expect(html).toContain('href="/servers/new"');
  });
});
