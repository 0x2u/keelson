import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FakeEnvAgent } from "./fake-env-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-vars-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({
  require: vi.fn(async () => {}),
  stepUp: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/session", () => ({
  requireSession: session.require,
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("@/lib/step-up", () => ({ stepUpError: session.stepUp }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const actions = await import("@/app/build-vars-actions");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { describeDashboardAudit } = await import("@/lib/audit-core");
const { agentFor } = await import("@/lib/agent");

const builder = new FakeEnvAgent();
let appServer = "";
let builderId = "";
const SECRET_VALUE = "postgres://shop:hunter2-super-secret@127.0.0.1:5432/shop";
const OTHER_VALUE = "another-confidential-value";

beforeAll(async () => {
  await builder.start();
  appServer = servers.createServer({
    name: "vps-1",
    url: "https://vps-1.example.com",
    token: "t".repeat(40),
    deploySecret: "s".repeat(40),
  });
  builderId = servers.createServer({
    name: "build-1",
    url: builder.url,
    token: "t".repeat(40),
    deploySecret: "s".repeat(40),
  });
});
afterAll(async () => {
  await builder.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db().exec("DELETE FROM audit_log");
  builder.buildVars.clear();
  builder.requests.length = 0;
  builder.opts = {};
  session.require.mockClear();
  session.require.mockImplementation(async () => {});
  session.stepUp.mockClear();
  session.stepUp.mockImplementation(async () => null);
});

const audit = () => store.recentAudit(50).map((e) => `${e.event}: ${e.detail}`);
const auditDump = () =>
  JSON.stringify(db().prepare("SELECT * FROM audit_log").all());

describe("saveBuildVarsAction", () => {
  it("requires a session and the unlock before anything reaches the builder", async () => {
    session.require.mockImplementation(async () => {
      throw new Error("no session");
    });
    await expect(
      actions.saveBuildVarsAction(appServer, builderId, "shop", [
        { key: "A", value: SECRET_VALUE },
      ]),
    ).rejects.toThrow("no session");
    await expect(
      actions.deleteBuildVarsAction(appServer, builderId, "shop"),
    ).rejects.toThrow("no session");
    session.require.mockImplementation(async () => {});
    session.stepUp.mockImplementation(
      async () =>
        "Stored variables need you to unlock sensitive changes first.",
    );
    expect(
      await actions.saveBuildVarsAction(appServer, builderId, "shop", [
        { key: "A", value: SECRET_VALUE },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringContaining("unlock") });
    expect(
      await actions.deleteBuildVarsAction(appServer, builderId, "shop"),
    ).toMatchObject({ ok: false });
    expect(builder.requests).toEqual([]);
    expect(audit()).toEqual([]);
  });

  it("sets build variables on the builder in one signed request, for an app that is not in its apps file, audits the names and says nothing of the values", async () => {
    const result = await actions.saveBuildVarsAction(
      appServer,
      builderId,
      "shop",
      [
        { key: "DATABASE_URL", value: SECRET_VALUE },
        { key: "NEXT_PUBLIC_API", value: OTHER_VALUE },
      ],
    );
    expect(result).toEqual({ ok: true, changed: 2, removed: 0 });
    const puts = builder.requests.filter((r) => r.line.startsWith("PUT"));
    expect(puts).toHaveLength(1);
    expect(puts[0].line).toBe("PUT /v1/build-vars/shop");
    expect(JSON.parse(puts[0].body)).toEqual({
      set: { DATABASE_URL: SECRET_VALUE, NEXT_PUBLIC_API: OTHER_VALUE },
      remove: [],
    });
    expect([...(builder.buildVars.get("shop")?.keys() ?? [])].sort()).toEqual([
      "DATABASE_URL",
      "NEXT_PUBLIC_API",
    ]);
    expect(audit()).toEqual([
      "build_vars_set: build-1: shop (build variables): DATABASE_URL, NEXT_PUBLIC_API",
    ]);
    expect(auditDump()).not.toContain("hunter2");
    expect(auditDump()).not.toContain(OTHER_VALUE);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("removes names and audits them apart from the sets", async () => {
    await actions.saveBuildVarsAction(appServer, builderId, "shop", [
      { key: "OLD", value: "old-value-1" },
      { key: "KEEP", value: "keep-value-1" },
    ]);
    db().exec("DELETE FROM audit_log");
    const result = await actions.saveBuildVarsAction(
      appServer,
      builderId,
      "shop",
      [{ key: "NEW", value: "new-value-1" }],
      ["OLD"],
    );
    expect(result).toEqual({ ok: true, changed: 1, removed: 1 });
    expect(audit().reverse()).toEqual([
      "build_vars_set: build-1: shop (build variables): NEW",
      "build_vars_unset: build-1: shop (build variables): OLD",
    ]);
    expect([...(builder.buildVars.get("shop")?.keys() ?? [])].sort()).toEqual([
      "KEEP",
      "NEW",
    ]);
  });

  it("refuses bad names and values before asking the agent, by key, and without audit", async () => {
    const result = await actions.saveBuildVarsAction(
      appServer,
      builderId,
      "shop",
      [
        { key: "bad-name", value: SECRET_VALUE },
        { key: "KEELSON_X", value: "v" },
        { key: "OK", value: "a\0b" },
      ],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.key)).toEqual([
      "bad-name",
      "KEELSON_X",
      "OK",
    ]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(builder.requests.some((r) => r.line.startsWith("PUT"))).toBe(false);
    expect(audit()).toEqual([]);
  });

  it("refuses an empty change and an unknown server", async () => {
    expect(
      await actions.saveBuildVarsAction(appServer, builderId, "shop", [], []),
    ).toMatchObject({ ok: false, error: "Nothing to save." });
    expect(
      await actions.saveBuildVarsAction(appServer, "nope", "shop", [
        { key: "A", value: "1" },
      ]),
    ).toMatchObject({ ok: false, error: "Unknown server." });
    expect(builder.requests).toEqual([]);
  });

  it("passes the agent's refusal on with its per-key problems, cleaned of any value it echoed, and audits the failure by key names only", async () => {
    builder.opts.refuseWith = {
      message: `value ${SECRET_VALUE} is not allowed`,
      issues: [{ key: "DATABASE_URL", message: `contains ${SECRET_VALUE}` }],
    };
    const result = await actions.saveBuildVarsAction(
      appServer,
      builderId,
      "shop",
      [{ key: "DATABASE_URL", value: SECRET_VALUE }],
    );
    expect(result).toEqual({
      ok: false,
      error: "value [redacted] is not allowed",
      issues: [{ key: "DATABASE_URL", message: "contains [redacted]" }],
    });
    expect(audit()).toEqual([
      "build_vars_failed: build-1: shop (build variables): DATABASE_URL: value [redacted] is not allowed",
    ]);
    expect(auditDump()).not.toContain("hunter2");
  });

  it("says that the agent is too old, for an agent without the routes", async () => {
    builder.opts.old = true;
    expect(
      await actions.saveBuildVarsAction(appServer, builderId, "shop", [
        { key: "A", value: "1" },
      ]),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("too old to keep build variables"),
    });
    expect(
      await actions.deleteBuildVarsAction(appServer, builderId, "shop"),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("too old to keep build variables"),
    });
  });
});

describe("deleteBuildVarsAction", () => {
  it("removes every build variable of the app on the builder and audits the names that were stored", async () => {
    await actions.saveBuildVarsAction(appServer, builderId, "shop", [
      { key: "B", value: "b-value-1" },
      { key: "A", value: "a-value-1" },
    ]);
    await actions.saveBuildVarsAction(appServer, builderId, "other", [
      { key: "C", value: "c-value-1" },
    ]);
    db().exec("DELETE FROM audit_log");
    expect(
      await actions.deleteBuildVarsAction(appServer, builderId, "shop"),
    ).toEqual({ ok: true, changed: 0, removed: 2 });
    expect(audit()).toEqual([
      "build_vars_delete: build-1: shop (build variables): A, B",
    ]);
    expect([...(builder.buildVars.get("other")?.keys() ?? [])]).toEqual(["C"]);
  });
});

describe("the AgentClient calls", () => {
  it("lists names and times, never values", async () => {
    await actions.saveBuildVarsAction(appServer, builderId, "shop", [
      { key: "DATABASE_URL", value: SECRET_VALUE },
    ]);
    const creds = servers.getCredentials(builderId)!;
    const listing = await agentFor(creds).buildVars("shop");
    expect(listing?.names).toEqual([
      { name: "DATABASE_URL", changed_at: expect.any(String) },
    ]);
    expect(JSON.stringify(listing)).not.toContain("hunter2");
    builder.opts.old = true;
    expect(await agentFor(creds).buildVars("shop")).toBeNull();
  });
});

describe("the audit lines of build variables", () => {
  it("are known to the audit page, read as sentences with the names and no value", async () => {
    await actions.saveBuildVarsAction(appServer, builderId, "shop", [
      { key: "DATABASE_URL", value: SECRET_VALUE },
    ]);
    for (const e of store.recentAudit(10)) {
      const line = describeDashboardAudit(e);
      expect(line.known, e.event).toBe(true);
      expect(line.sentence).not.toContain("hunter2");
    }
  });
});
