import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, AppStatus, ConfigDocument, SaveResult } from "@/lib/agent-types";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-run-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {},
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const STORED: AppConfig = { name: "shop", image: "ghcr.io/acme/shop", env: { SECRET: "<hidden>" }, domains: ["shop.example.com"], port: 3000 };

/** What the agent holds and what it was asked, in order. */
const agent = {
  calls: [] as string[],
  saved: [] as { name: string; app: AppConfig; base_hash: string; comment?: string }[],
  stored: STORED as AppConfig,
  hash: "h1",
  configError: undefined as string | undefined,
  save: { ok: true, hash: "h2", issues: [] } as SaveResult,
  startError: null as Error | null,
  container: { name: "/shop-1" } as { name: string } | null,
};
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  agentFor: () => ({
    config: async (): Promise<ConfigDocument> => {
      agent.calls.push("config");
      return { content: "", hash: agent.hash, modified_at: "", model: { apps: [agent.stored] }, error: agent.configError, applied_hash: agent.hash } as ConfigDocument;
    },
    saveApp: async (name: string, app: AppConfig, opts: { base_hash: string; comment?: string }) => {
      agent.calls.push("saveApp");
      agent.saved.push({ name, app, ...opts });
      return agent.save;
    },
    apps: async () => {
      agent.calls.push("apps");
      return [{ name: "shop", container: agent.container } as unknown as AppStatus];
    },
    containerAction: async (name: string, action: string) => {
      agent.calls.push(`${action} ${name}`);
      if (agent.startError) throw agent.startError;
    },
  }),
}));

const { db } = await import("@/lib/db");
const { AgentError } = await import("@/lib/agent");
const { startAppAction, stopAppAction } = await import("@/app/app-run-actions");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let id = "";
beforeAll(() => {
  id = servers.createServer({ name: "prod", url: "https://203.0.113.7:8443", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db().exec("DELETE FROM audit_log");
  Object.assign(agent, { calls: [], saved: [], stored: STORED, hash: "h1", configError: undefined, save: { ok: true, hash: "h2", issues: [] }, startError: null, container: { name: "/shop-1" } });
});
const events = () => store.recentAudit(10).map((e) => e.event);

describe("stopAppAction", () => {
  it("writes enabled: false through the config API, on the hash it read, and keeps everything else of the app", async () => {
    expect(await stopAppAction(id, "shop")).toEqual({});
    expect(agent.saved).toEqual([{ name: "shop", app: { ...STORED, enabled: false }, base_hash: "h1", comment: "Stop shop" }]);
    expect(agent.calls).toEqual(["config", "saveApp"]);
    expect(store.recentAudit(10)).toMatchObject([{ event: "app_stop", detail: "prod: shop", ip: "127.0.0.1" }]);
  });

  it("writes nothing when the app is stopped already", async () => {
    agent.stored = { ...STORED, enabled: false };
    expect(await stopAppAction(id, "shop")).toEqual({});
    expect(agent.saved).toEqual([]);
  });

  it("reports the agent's refusal, an edit that raced it, and an unknown app, and audits the failure", async () => {
    agent.save = { ok: false, kind: "invalid", message: "enabled: false is not valid on an app without a container", issues: [] };
    expect(await stopAppAction(id, "shop")).toEqual({ error: "enabled: false is not valid on an app without a container" });
    agent.save = { ok: false, kind: "changed", issues: [], hash: "h9" };
    expect((await stopAppAction(id, "shop")).error).toMatch(/changed by someone else/);
    expect((await stopAppAction(id, "ghost")).error).toMatch(/not in the apps file/);
    agent.configError = "line 3: bad";
    expect((await stopAppAction(id, "shop")).error).toMatch(/invalid: line 3: bad/);
    expect(events()).toEqual(["app_stop_failed", "app_stop_failed", "app_stop_failed", "app_stop_failed"]);
  });

  it("refuses an unknown server without asking any agent", async () => {
    expect(await stopAppAction("nope", "shop")).toEqual({ error: "Unknown server." });
    expect(agent.calls).toEqual([]);
  });
});

describe("startAppAction", () => {
  beforeEach(() => {
    agent.stored = { ...STORED, enabled: false };
  });

  it("clears enabled through the config API first, then starts the container", async () => {
    expect(await startAppAction(id, "shop")).toEqual({});
    expect(agent.saved).toHaveLength(1);
    expect(agent.saved[0]).toMatchObject({ name: "shop", base_hash: "h1", comment: "Start shop" });
    expect(agent.saved[0].app).toEqual(STORED);
    expect("enabled" in agent.saved[0].app).toBe(false);
    expect(agent.calls).toEqual(["config", "saveApp", "apps", "start shop-1"]);
    expect(events().sort()).toEqual(["app_start", "container_start"]);
  });

  it("does not start the container when clearing enabled failed", async () => {
    agent.save = { ok: false, kind: "busy", issues: [] };
    expect((await startAppAction(id, "shop")).error).toMatch(/cannot apply this change right now/);
    expect(agent.calls).not.toContain("start shop-1");
    expect(events()).toEqual(["app_start_failed"]);
  });

  it("keeps the first step when the container does not start, and says what is left to do", async () => {
    agent.startError = new AgentError(500, "docker: no such image");
    const r = await startAppAction(id, "shop");
    expect(r.error).toBe("shop is enabled again, but its container shop-1 did not start: docker: no such image. Start it from the container's page, or press Start again.");
    expect(agent.saved).toHaveLength(1);
    expect(events().sort()).toEqual(["app_start", "container_start_failed"]);
  });

  it("can be pressed again after that: an app that is enabled already is not written again, and the container starts", async () => {
    agent.stored = { ...STORED };
    expect(await startAppAction(id, "shop")).toEqual({});
    expect(agent.saved).toEqual([]);
    expect(agent.calls).toContain("start shop-1");
  });

  it("says the app has no container to start (never deployed) instead of failing silently", async () => {
    agent.container = null;
    expect((await startAppAction(id, "shop")).error).toBe("shop is enabled again, but it has no container to start. Deploy it to bring it up.");
  });
});
