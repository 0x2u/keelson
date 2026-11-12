import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsDomainCard } from "@/components/servers/AppsDomainCard";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-apps-domain-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let anonymous = false;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (anonymous) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const { saveAppsDomainAction } = await import("@/app/apps-domain-actions");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let id = "";
beforeAll(() => {
  id = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  anonymous = false;
  db().exec("DELETE FROM audit_log");
  servers.setAppsDomain(id, null);
});

const form = (value: string) => {
  const f = new FormData();
  f.set("appsDomain", value);
  return f;
};

describe("saveAppsDomainAction", () => {
  it("saves a domain in its clean form, audits it by server name, and says what was saved", async () => {
    const out = await saveAppsDomainAction(id, {}, form("  Apps.Example.com "));
    expect(out).toEqual({ saved: "apps.example.com" });
    expect(servers.getServer(id)!.appsDomain).toBe("apps.example.com");
    expect(store.recentAudit(5).map((e) => [e.event, e.detail])).toEqual([["apps_domain_set", "staging: apps.example.com"]]);
  });

  it("clears the domain with an empty text", async () => {
    servers.setAppsDomain(id, "apps.example.com");
    expect(await saveAppsDomainAction(id, {}, form(""))).toEqual({ saved: null });
    expect(servers.getServer(id)!.appsDomain).toBeNull();
    expect(store.recentAudit(5)[0]!.detail).toBe("staging: none");
  });

  it("refuses what is not a domain name and changes nothing", async () => {
    servers.setAppsDomain(id, "apps.example.com");
    for (const bad of ["https://apps.example.com", "203.0.113.7", "*.example.com", "localhost"]) {
      const out = await saveAppsDomainAction(id, {}, form(bad));
      expect(out.error, bad).toBeDefined();
      expect(out.saved).toBeUndefined();
    }
    expect(servers.getServer(id)!.appsDomain).toBe("apps.example.com");
    expect(store.recentAudit(5)).toEqual([]);
  });

  it("does nothing for a server that is not there, and needs a session", async () => {
    expect((await saveAppsDomainAction("nope", {}, form("apps.example.com"))).error).toBe("Unknown server.");
    anonymous = true;
    await expect(saveAppsDomainAction(id, {}, form("apps.example.com"))).rejects.toThrow("NO_SESSION");
    expect(servers.getServer(id)!.appsDomain).toBeNull();
  });
});

describe("the apps domain card", () => {
  const card = (current: string | null) => renderToStaticMarkup(createElement(AppsDomainCard, { serverId: id, current }));

  it("shows the saved domain in the field and in the sentence that says what it does", () => {
    const out = card("apps.example.com");
    expect(out).toContain('value="apps.example.com"');
    expect(out).toContain("&lt;project&gt;.apps.example.com");
    expect(out).toContain("Leave it empty for no default");
  });

  it("shows an empty field and a placeholder sentence when no domain is set", () => {
    const out = card(null);
    expect(out).toContain('value=""');
    expect(out).toContain("your-domain");
    expect(out).toContain('placeholder="apps.example.com"');
  });
});
