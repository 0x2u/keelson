import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-container-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {},
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const agent = { calls: [] as string[], fail: null as Error | null };
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  agentFor: () => ({
    containerAction: async (name: string, action: string) => {
      agent.calls.push(`${action} ${name}`);
      if (agent.fail) throw agent.fail;
    },
  }),
}));

const { db } = await import("@/lib/db");
const { AgentError, AGENT_TOO_OLD_FOR_CONTAINER_ACTIONS } = await import("@/lib/agent");
const { containerAction } = await import("@/app/container-actions");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let id = "";
beforeAll(() => {
  id = servers.createServer({ name: "prod", url: "https://203.0.113.7:8443", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db().exec("DELETE FROM audit_log");
  agent.calls.length = 0;
  agent.fail = null;
});

describe("containerAction", () => {
  it("starts a container and audits container_start", async () => {
    expect(await containerAction(id, "web", "start")).toEqual({});
    expect(agent.calls).toEqual(["start web"]);
    expect(store.recentAudit(10)).toMatchObject([{ event: "container_start", detail: "prod: web", ip: "127.0.0.1" }]);
  });

  it("restarts a container and audits container_restart", async () => {
    expect(await containerAction(id, "web", "restart")).toEqual({});
    expect(store.recentAudit(10).map((e) => e.event)).toEqual(["container_restart"]);
  });

  it("says plainly that the agent is too old, and audits the failure", async () => {
    agent.fail = new AgentError(404, AGENT_TOO_OLD_FOR_CONTAINER_ACTIONS);
    const r = await containerAction(id, "web", "start");
    expect(r.error).toMatch(/too old/);
    expect(store.recentAudit(10).map((e) => e.event)).toEqual(["container_start_failed"]);
  });

  it("refuses an unknown server and an unknown action without calling the agent", async () => {
    expect(await containerAction("nope", "web", "start")).toEqual({ error: "Unknown server." });
    expect(await containerAction(id, "web", "stop" as "start")).toEqual({ error: "Unknown action." });
    expect(agent.calls).toEqual([]);
  });
});
