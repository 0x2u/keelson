import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEnvAgent } from "./fake-env-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-env-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({ require: vi.fn(async () => {}) }));
vi.mock("@/lib/session", () => ({ requireSession: session.require, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const actions = await import("@/app/env-actions");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { describeDashboardAudit } = await import("@/lib/audit-core");

const agent = new FakeEnvAgent();
let serverId = "";
const SECRET_VALUE = "postgres://app:hunter2-super-secret@db.internal/app";
const OTHER_VALUE = "another-confidential-value";

beforeAll(async () => {
  await agent.start();
  serverId = servers.createServer({ name: "staging", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db().exec("DELETE FROM audit_log");
  agent.scopes.app.clear();
  agent.scopes.preview.clear();
  agent.requests.length = 0;
  agent.opts = {};
  session.require.mockClear();
  session.require.mockImplementation(async () => {});
});

const audit = () => store.recentAudit(50).map((e) => `${e.event}: ${e.detail}`);
const auditDump = () => JSON.stringify(db().prepare("SELECT * FROM audit_log").all());

describe("saveEnvAction", () => {
  it("requires a session before anything else", async () => {
    session.require.mockImplementation(async () => {
      throw new Error("no session");
    });
    await expect(actions.saveEnvAction(serverId, "shop", "app", [{ key: "A", value: SECRET_VALUE, build: false }])).rejects.toThrow("no session");
    await expect(actions.deleteEnvScopeAction(serverId, "shop", "app")).rejects.toThrow("no session");
    expect(agent.requests).toEqual([]);
    expect(audit()).toEqual([]);
  });

  it("sets variables in one signed request, audits the key names, and says nothing of the values", async () => {
    const result = await actions.saveEnvAction(serverId, "shop", "app", [
      { key: "DATABASE_URL", value: SECRET_VALUE, build: false },
      { key: "NEXT_PUBLIC_API", value: OTHER_VALUE, build: true },
    ]);
    expect(result).toEqual({ ok: true, changed: 2, removed: 0 });
    const puts = agent.requests.filter((r) => r.line.startsWith("PUT"));
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body)).toEqual({ scope: "app", set: { DATABASE_URL: SECRET_VALUE, NEXT_PUBLIC_API: OTHER_VALUE }, build: ["NEXT_PUBLIC_API"] });
    expect(audit()).toEqual(["env_set: staging: shop (app): DATABASE_URL, NEXT_PUBLIC_API (build: NEXT_PUBLIC_API)"]);
    expect(auditDump()).not.toContain(SECRET_VALUE);
    expect(auditDump()).not.toContain(OTHER_VALUE);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("removes names and audits them apart from the sets", async () => {
    agent.seed("app", "OLD", "old-value-1");
    agent.seed("app", "KEEP", "keep-value-1");
    const result = await actions.saveEnvAction(serverId, "shop", "app", [{ key: "NEW", value: "new-value-1", build: false }], ["OLD"]);
    expect(result).toEqual({ ok: true, changed: 1, removed: 1 });
    expect(audit().reverse()).toEqual(["env_set: staging: shop (app): NEW", "env_unset: staging: shop (app): OLD"]);
    expect([...agent.scopes.app.keys()].sort()).toEqual(["KEEP", "NEW"]);
  });

  it("keeps the build arguments that are stored when it changes others (the agent takes the whole list)", async () => {
    agent.seed("app", "NEXT_PUBLIC_A", "a-value-1", { build: true });
    await actions.saveEnvAction(serverId, "shop", "app", [{ key: "B", value: "b-value-1", build: false }]);
    const put = agent.requests.find((r) => r.line.startsWith("PUT"))!;
    expect(JSON.parse(put.body).build).toEqual(["NEXT_PUBLIC_A"]);
    expect(agent.scopes.app.get("NEXT_PUBLIC_A")?.build).toBe(true);
  });

  it("changes only the build flag when the edit carries no value", async () => {
    agent.seed("app", "VITE_X", "x-value-1");
    expect(await actions.saveEnvAction(serverId, "shop", "app", [{ key: "VITE_X", value: null, build: true }])).toEqual({ ok: true, changed: 0, removed: 0 });
    const put = agent.requests.find((r) => r.line.startsWith("PUT"))!;
    expect(JSON.parse(put.body)).toEqual({ scope: "app", set: {}, build: ["VITE_X"] });
    expect(agent.scopes.app.get("VITE_X")).toMatchObject({ value: "x-value-1", build: true });
    expect(audit()).toEqual(["env_build: staging: shop (app): build on: VITE_X"]);
    await actions.saveEnvAction(serverId, "shop", "app", [{ key: "VITE_X", value: null, build: false }]);
    expect(audit()[0]).toBe("env_build: staging: shop (app): build off: VITE_X");
  });

  it("refuses bad names and values before asking the agent, by key, and without audit", async () => {
    const result = await actions.saveEnvAction(serverId, "shop", "app", [
      { key: "bad-name", value: SECRET_VALUE, build: false },
      { key: "KEELSON_X", value: "v", build: false },
      { key: "OK", value: "a\0b", build: false },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.key)).toEqual(["bad-name", "KEELSON_X", "OK"]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(agent.requests.some((r) => r.line.startsWith("PUT"))).toBe(false);
    expect(audit()).toEqual([]);
  });

  it("refuses an empty change, a bad scope and an unknown server", async () => {
    expect(await actions.saveEnvAction(serverId, "shop", "app", [])).toMatchObject({ ok: false, error: "Nothing to save." });
    expect(await actions.saveEnvAction(serverId, "shop", "weird" as never, [{ key: "A", value: "1", build: false }])).toMatchObject({ ok: false, error: "Unknown scope." });
    expect(await actions.saveEnvAction("nope", "shop", "app", [{ key: "A", value: "1", build: false }])).toMatchObject({ ok: false, error: "Unknown server." });
    expect(agent.requests).toEqual([]);
  });

  it("passes the agent's refusal on with its per-key problems, and audits the failure by key names only", async () => {
    agent.opts.refuseWith = { message: `value ${SECRET_VALUE} is not allowed`, issues: [{ key: "DATABASE_URL", message: `contains ${SECRET_VALUE}` }] };
    const result = await actions.saveEnvAction(serverId, "shop", "app", [{ key: "DATABASE_URL", value: SECRET_VALUE, build: false }]);
    expect(result).toEqual({ ok: false, error: "value [redacted] is not allowed", issues: [{ key: "DATABASE_URL", message: "contains [redacted]" }] });
    expect(audit()).toEqual(["env_set_failed: staging: shop (app): DATABASE_URL: value [redacted] is not allowed"]);
    expect(auditDump()).not.toContain("hunter2");
  });

  it("says that the agent is too old, for an agent without the routes", async () => {
    agent.opts.old = true;
    const result = await actions.saveEnvAction(serverId, "shop", "preview", [{ key: "A", value: "1", build: false }]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("too old to manage variables") });
  });

  it("works on the preview scope apart from the app's", async () => {
    await actions.saveEnvAction(serverId, "shop", "preview", [{ key: "A", value: "preview-value-1", build: false }]);
    expect([...agent.scopes.preview.keys()]).toEqual(["A"]);
    expect(agent.scopes.app.size).toBe(0);
    expect(audit()).toEqual(["env_set: staging: shop (preview): A"]);
  });
});

describe("the audit lines the actions write", () => {
  it("are all known to the audit page, read as sentences with the names and no value", async () => {
    agent.seed("app", "OLD", "old-value-1");
    await actions.saveEnvAction(serverId, "shop", "app", [{ key: "NEW", value: SECRET_VALUE, build: true }], ["OLD"]);
    await actions.saveEnvAction(serverId, "shop", "app", [{ key: "NEW", value: null, build: false }]);
    agent.opts.refuseWith = { message: "nope", issues: [] };
    await actions.saveEnvAction(serverId, "shop", "app", [{ key: "X", value: "1", build: false }]);
    await actions.deleteEnvScopeAction(serverId, "shop", "app");
    const lines = store.recentAudit(50).map((e) => describeDashboardAudit({ event: e.event, detail: e.detail }));
    expect(lines.length).toBe(5);
    for (const line of lines) expect(line.known).toBe(true);
    expect(lines.map((l) => l.sentence)).toEqual(
      expect.arrayContaining([
        "Set environment variables: staging: shop (app): NEW (build: NEW)",
        "Removed environment variables: staging: shop (app): OLD",
        "Changed what is available at build time: staging: shop (app): build off: NEW",
        "Could not set environment variables: staging: shop (app): X: nope",
        "Deleted every environment variable of a scope: staging: shop (app): NEW",
      ]),
    );
    expect(JSON.stringify(lines)).not.toContain("hunter2");
  });
});

describe("deleteEnvScopeAction", () => {
  it("removes the whole scope and audits the names that were stored", async () => {
    agent.seed("app", "A", "value-a-1");
    agent.seed("app", "B", "value-b-1");
    agent.seed("preview", "P", "value-p-1");
    expect(await actions.deleteEnvScopeAction(serverId, "shop", "app")).toEqual({ ok: true, changed: 0, removed: 2 });
    expect(agent.scopes.app.size).toBe(0);
    expect(agent.scopes.preview.size).toBe(1);
    expect(audit()).toEqual(["env_delete: staging: shop (app): A, B"]);
    expect(auditDump()).not.toContain("value-a-1");
  });

  it("reports an agent that is too old", async () => {
    agent.opts.old = true;
    expect(await actions.deleteEnvScopeAction(serverId, "shop", "app")).toMatchObject({ ok: false, error: expect.stringContaining("too old") });
  });
});
