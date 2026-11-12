import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeReadinessAgent } from "./fake-readiness-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-readiness-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({ require: vi.fn(async () => {}) }));
vi.mock("@/lib/session", () => ({ requireSession: session.require, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: vi.fn(async () => "step-up must not be asked for") }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/readiness-actions");
const servers = await import("@/lib/servers");
const { db } = await import("@/lib/db");
const { AGENT_TOO_OLD_FOR_READINESS } = await import("@/lib/agent");

// A well-formed age secret key (the shape is what is checked; it opens nothing).
const KEY = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
const KEY_FILE = `# created: 2026-11-02T10:00:00Z\n# public key: age1abcdef\n${KEY}\n`;

const agent = new FakeReadinessAgent();
let id = "";
beforeAll(async () => {
  await agent.start();
  id = servers.createServer({ name: "alpha", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  agent.opts = {};
  agent.requests.length = 0;
  session.require.mockClear();
  db().exec("DELETE FROM audit_log");
});

/** Nothing the dashboard keeps may hold the key: its audit trail, and every request to the agent other than the one that carries it. */
function expectNoKeyLeft(): void {
  expect(JSON.stringify(db().prepare("SELECT * FROM audit_log").all())).not.toContain("AGE-SECRET-KEY");
}

describe("verifyKeyAction", () => {
  it("sends the key alone to the agent, signed, and returns the answer without it", async () => {
    const out = await actions.verifyKeyAction(id, "main", { identity: KEY_FILE });
    expect(out).toEqual({ result: { ok: true, backup: "k1", backup_time: "2026-11-02T03:00:00Z" } });
    expect(session.require).toHaveBeenCalled();
    expect(agent.bodies("POST /v1/databases/main/verify-key")).toEqual([{ identity: KEY }]);
    expect(JSON.stringify(out)).not.toContain("AGE-SECRET-KEY");
    expectNoKeyLeft();
  });

  it("names the backup only when the operator chose one", async () => {
    await actions.verifyKeyAction(id, "main", { identity: KEY, backup: "main/2026-11-01.age" });
    expect(agent.bodies("POST /v1/databases/main/verify-key")).toEqual([{ identity: KEY, backup: "main/2026-11-01.age" }]);
  });

  it("returns a wrong key as a result, not an error", async () => {
    agent.opts.verify = { status: 200, body: { ok: false, reason: "wrong_key" } };
    expect(await actions.verifyKeyAction(id, "main", { identity: KEY })).toEqual({ result: { ok: false, reason: "wrong_key" } });
  });

  it("refuses what is not a key before asking the agent", async () => {
    const out = await actions.verifyKeyAction(id, "main", { identity: "age1publickeyisnotsecret" });
    expect(out).toEqual({ error: expect.stringContaining("AGE-SECRET-KEY-1") });
    expect(agent.requests).toEqual([]);
  });

  it("scrubs the key from an error the agent gives, even if the agent quotes it", async () => {
    agent.opts.verify = { status: 400, body: { error: `invalid identity ${KEY}` } };
    const out = await actions.verifyKeyAction(id, "main", { identity: KEY });
    expect(out.error).toBeDefined();
    expect(out.error).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain("AGE-SECRET-KEY-1QQ");
    expectNoKeyLeft();
  });

  it("says the agent is too old when it has no such route, and otherwise passes the agent's own refusal on", async () => {
    agent.opts.old = true;
    expect(await actions.verifyKeyAction(id, "main", { identity: KEY })).toEqual({ error: AGENT_TOO_OLD_FOR_READINESS });
    agent.opts = { verify: { status: 404, body: { error: "unknown database nope" } } };
    expect(await actions.verifyKeyAction(id, "nope", { identity: KEY })).toEqual({ error: "unknown database nope" });
  });

  it("refuses an unknown server", async () => {
    expect(await actions.verifyKeyAction("nope", "main", { identity: KEY })).toEqual({ error: "Unknown server." });
  });
});

describe("the restore test", () => {
  it("starts into a scratch database without asking for an unlock, and follows it to the table counts", async () => {
    agent.opts.runningReads = 1;
    const started = await actions.startRestoreTestAction(id, "main", { identity: KEY_FILE, backup: "k1" });
    expect(started).toEqual({ testId: "t1" });
    expect(agent.bodies("POST /v1/databases/main/restore-test")).toEqual([{ identity: KEY, backup: "k1" }]);

    const first = await actions.restoreTestAction(id, "main", "t1");
    expect(first).toMatchObject({ test: { id: "t1", status: "running" } });
    const second = await actions.restoreTestAction(id, "main", "t1");
    expect(second).toMatchObject({ test: { status: "passed", tables: [{ name: "public.products", backup_rows: 3, live_rows: 5 }] } });
    expect(JSON.stringify([started, first, second])).not.toContain("AGE-SECRET-KEY");
    expectNoKeyLeft();
  });

  it("passes on the agent's refusal while a backup or another test runs", async () => {
    agent.opts.startTest = { status: 409, body: { error: "a backup of main is running" } };
    expect(await actions.startRestoreTestAction(id, "main", { identity: KEY })).toEqual({ error: "a backup of main is running" });
  });

  it("scrubs the key from a refusal that quotes it", async () => {
    agent.opts.startTest = { status: 400, body: { error: `bad key ${KEY}` } };
    const out = await actions.startRestoreTestAction(id, "main", { identity: KEY });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("refuses a missing key without calling the agent, and an agent without the route as too old", async () => {
    expect(await actions.startRestoreTestAction(id, "main", { identity: "" })).toEqual({ error: expect.stringContaining("AGE-SECRET-KEY-1") });
    expect(agent.requests).toEqual([]);
    agent.opts.old = true;
    expect(await actions.startRestoreTestAction(id, "main", { identity: KEY })).toEqual({ error: AGENT_TOO_OLD_FOR_READINESS });
  });

  it("returns a failed test with the agent's cause, and says so when the agent has no record of a test", async () => {
    agent.opts.outcome = { status: "failed", error: "pg_restore: out of memory", tables: [] };
    await actions.startRestoreTestAction(id, "main", { identity: KEY });
    expect(await actions.restoreTestAction(id, "main", "t1")).toMatchObject({ test: { status: "failed", error: "pg_restore: out of memory" } });
    expect(await actions.restoreTestAction(id, "main", "t9")).toEqual({ error: "The agent has no record of this test." });
  });
});

describe("testAlertAction", () => {
  it("returns how each channel went, as the agent classified it", async () => {
    agent.opts.alert = { status: 200, body: { channels: [{ channel: "telegram", ok: true }, { channel: "webhook", ok: false, reason: "rejected" }] } };
    expect(await actions.testAlertAction(id)).toEqual({ result: { channels: [{ channel: "telegram", ok: true }, { channel: "webhook", ok: false, reason: "rejected" }] } });
    expect(agent.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /v1/notifications/test"]);
  });

  it("returns no channels when none is configured, and says an old agent is too old", async () => {
    agent.opts.alert = { status: 200, body: { channels: [] } };
    expect(await actions.testAlertAction(id)).toEqual({ result: { channels: [] } });
    agent.opts = { old: true };
    expect(await actions.testAlertAction(id)).toEqual({ error: AGENT_TOO_OLD_FOR_READINESS });
  });
});
