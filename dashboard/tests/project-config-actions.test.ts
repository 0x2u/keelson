import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProjectAgent } from "./fake-project-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-project-config-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const session = vi.hoisted(() => ({ require: vi.fn(async () => {}) }));
const stepUp = vi.hoisted(() => ({ error: vi.fn<(verdict: { required: boolean }, what: string) => Promise<string | null>>(async () => null) }));
const revalidated = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@/lib/session", () => ({ requireSession: session.require, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: stepUp.error }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.paths.push(p) }));

const actions = await import("@/app/project-config-actions");
const servers = await import("@/lib/servers");
const { agentFor } = await import("@/lib/agent");

const agent = new FakeProjectAgent();
let serverId = "";

beforeAll(async () => {
  await agent.start();
  serverId = servers.createServer({ name: "vps-1", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  agent.requests.length = 0;
  agent.opts = {};
  revalidated.paths.length = 0;
  session.require.mockClear();
  session.require.mockImplementation(async () => {});
  stepUp.error.mockClear();
  stepUp.error.mockImplementation(async () => null);
});

const FILE = { project: "shop", content: "apps:\n  - name: web\n", hash: "h1", apps: ["web"] };
const PLAN = {
  project: "shop",
  file: "projects.d/shop.yaml",
  apps: ["shop"],
  jobs: ["daily-report"],
  databases: [],
  previews: [],
  kept: [{ kind: "database", name: "shared", reason: "also named by the release of app blog" }],
};

describe("the agent client's project routes", () => {
  const client = () => agentFor(servers.getCredentials(serverId)!);

  it("reads the list of project files, and an empty list is a feature that is there", async () => {
    expect(await client().projectFiles()).toEqual([]);
    agent.opts = { file: FILE };
    expect((await client().projectFiles())?.map((f) => f.name)).toEqual(["shop"]);
  });

  it("takes a 404 on GET /v1/projects for an agent without the feature", async () => {
    agent.opts = { old: true };
    expect(await client().projectFiles()).toBeNull();
  });

  it("reads one project's file and says null when there is none", async () => {
    agent.opts = { file: FILE };
    expect((await client().projectConfig("shop"))?.hash).toBe("h1");
    expect(await client().projectConfig("blog")).toBeNull();
  });
});

describe("validateProjectConfigAction", () => {
  it("requires a session before anything else", async () => {
    session.require.mockImplementation(async () => {
      throw new Error("no session");
    });
    await expect(actions.validateProjectConfigAction(serverId, "shop", "x")).rejects.toThrow("no session");
    expect(agent.requests).toEqual([]);
  });

  it("returns the issues with their file and line", async () => {
    const result = await actions.validateProjectConfigAction(serverId, "shop", "BAD");
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ file: "projects.d/shop.yaml", project: "shop", line: 3 })]);
    expect(agent.requests[0].line).toBe("POST /v1/projects/shop/config/validate");
  });

  it("says why when the agent is too old, and for an unknown server", async () => {
    agent.opts = { old: true };
    const old = await actions.validateProjectConfigAction(serverId, "shop", "x");
    expect(old.ok).toBe(false);
    expect("message" in old && old.message).toMatch(/too old/);
    expect(await actions.validateProjectConfigAction("nope", "shop", "x")).toEqual({ ok: false, issues: [], message: "Unknown server." });
  });
});

describe("saveProjectConfigAction", () => {
  it("asks for the step-up of a raw document, then saves with the file's hash as base", async () => {
    agent.opts = { file: FILE };
    const result = await actions.saveProjectConfigAction(serverId, "shop", "apps: []", { base_hash: "h1", comment: "tidy" });
    expect(stepUp.error).toHaveBeenCalledTimes(1);
    expect(stepUp.error.mock.calls[0][0]).toMatchObject({ required: true });
    expect(result).toEqual({ ok: true, hash: "new-file-hash", config_hash: "new-bundle-hash", version: 7, issues: [] });
    expect(agent.bodies("PUT /v1/projects/shop/config")).toEqual([{ content: "apps: []", base_hash: "h1", comment: "tidy" }]);
    expect(revalidated.paths).toContain("/projects");
    expect(revalidated.paths).toContain(`/servers/${serverId}`);
  });

  it("does not write when the step-up is refused", async () => {
    stepUp.error.mockImplementation(async () => "Unlock first.");
    agent.opts = { file: FILE };
    const result = await actions.saveProjectConfigAction(serverId, "shop", "apps: []", { base_hash: "h1" });
    expect(result).toEqual({ ok: false, kind: "error", message: "Unlock first.", issues: [] });
    expect(agent.requests.some((r) => r.line.startsWith("PUT"))).toBe(false);
  });

  it("hands back 409 changed with the file's current hash, and writes nothing", async () => {
    agent.opts = { file: { ...FILE, hash: "h2" } };
    const result = await actions.saveProjectConfigAction(serverId, "shop", "apps: []", { base_hash: "h1" });
    expect(result).toMatchObject({ ok: false, kind: "changed", hash: "h2" });
    expect(revalidated.paths).toEqual([]);
  });

  it("hands back the issues of an invalid file with file and line", async () => {
    agent.opts = { file: FILE };
    const result = await actions.saveProjectConfigAction(serverId, "shop", "BAD", { base_hash: "h1" });
    expect(result).toMatchObject({ ok: false, kind: "invalid", issues: [{ file: "projects.d/shop.yaml", line: 3 }] });
  });

  it("hands back needs_acknowledgement, and force sends it again acknowledged", async () => {
    agent.opts = { file: FILE };
    const asked = await actions.saveProjectConfigAction(serverId, "shop", "DROP", { base_hash: "h1" });
    expect(asked).toMatchObject({ ok: false, kind: "needs_acknowledgement", issues: [{ code: "app_removed" }] });
    const forced = await actions.saveProjectConfigAction(serverId, "shop", "DROP", { base_hash: "h1", force: true });
    expect(forced.ok).toBe(true);
    expect(agent.bodies("PUT /v1/projects/shop/config").map((b) => b.force)).toEqual([undefined, true]);
  });

  it("names the missing feature as an error result, not an exception", async () => {
    agent.opts = { old: true };
    const result = await actions.saveProjectConfigAction(serverId, "shop", "apps: []", { base_hash: "h1" });
    expect(result).toMatchObject({ ok: false, kind: "error", message: expect.stringMatching(/too old/) });
  });
});

describe("deleteProjectConfigAction", () => {
  it("is a sensitive change that needs the step-up", async () => {
    agent.opts = { file: { ...FILE, apps: [] } };
    const result = await actions.deleteProjectConfigAction(serverId, "shop", { base_hash: "h1" });
    expect(stepUp.error).toHaveBeenCalledTimes(1);
    expect(stepUp.error.mock.calls[0][1]).toContain("shop");
    expect(result).toMatchObject({ ok: true, hash: "" });
  });

  it("asks to acknowledge the apps that leave before removing anything", async () => {
    agent.opts = { file: FILE };
    const asked = await actions.deleteProjectConfigAction(serverId, "shop", { base_hash: "h1" });
    expect(asked).toMatchObject({ ok: false, kind: "needs_acknowledgement", issues: [{ code: "app_removed", path: "apps[web]" }] });
    const forced = await actions.deleteProjectConfigAction(serverId, "shop", { base_hash: "h1", force: true });
    expect(forced).toMatchObject({ ok: true });
    expect(agent.bodies("DELETE /v1/projects/shop/config").map((b) => b.force)).toEqual([undefined, true]);
  });

  it("refuses a stale hash and an unknown file", async () => {
    agent.opts = { file: { ...FILE, hash: "h2" } };
    expect(await actions.deleteProjectConfigAction(serverId, "shop", { base_hash: "h1", force: true })).toMatchObject({ ok: false, kind: "changed", hash: "h2" });
    agent.opts = {};
    expect(await actions.deleteProjectConfigAction(serverId, "shop", { base_hash: "h1", force: true })).toMatchObject({ ok: false, kind: "error" });
  });
});

describe("planSplitAction and splitProjectAction", () => {
  it("shows the plan with a dry run, which writes nothing", async () => {
    agent.opts = { plan: PLAN, configHash: "bundle-1" };
    const planned = await actions.planSplitAction(serverId, "shop");
    expect(planned).toEqual({ ok: true, hash: "bundle-1", plan: PLAN, issues: [] });
    expect(agent.bodies("POST /v1/projects/shop/split")).toEqual([{ dry_run: true }]);
    expect(revalidated.paths).toEqual([]);
  });

  it("says why the agent refuses (file exists, nothing to move, would change what runs)", async () => {
    agent.opts = { splitRefusal: "nothing belongs to the project shop" };
    expect(await actions.planSplitAction(serverId, "shop")).toEqual({ ok: false, message: "nothing belongs to the project shop" });
  });

  it("says the agent must be updated when it has no such route", async () => {
    agent.opts = { old: true };
    expect(await actions.planSplitAction(serverId, "shop")).toEqual({ ok: false, message: expect.stringMatching(/too old/) });
  });

  it("applies on the hash of the plan, and the result carries the new file's hash", async () => {
    agent.opts = { plan: PLAN, configHash: "bundle-1" };
    const done = await actions.splitProjectAction(serverId, "shop", { base_hash: "bundle-1" });
    expect(done).toEqual({ ok: true, hash: "split-file-hash", config_hash: "split-bundle-hash", version: 9, issues: [] });
    expect(agent.bodies("POST /v1/projects/shop/split")).toEqual([{ base_hash: "bundle-1" }]);
    expect(revalidated.paths).toContain("/projects");
  });

  it("does not move anything when the configuration changed after the plan (409 changed)", async () => {
    agent.opts = { plan: PLAN, configHash: "bundle-2" };
    const done = await actions.splitProjectAction(serverId, "shop", { base_hash: "bundle-1" });
    expect(done).toMatchObject({ ok: false, kind: "changed", hash: "bundle-2" });
    expect(revalidated.paths).toEqual([]);
  });

  it("requires a session", async () => {
    session.require.mockImplementation(async () => {
      throw new Error("no session");
    });
    await expect(actions.planSplitAction(serverId, "shop")).rejects.toThrow("no session");
    await expect(actions.splitProjectAction(serverId, "shop", { base_hash: "x" })).rejects.toThrow("no session");
    expect(agent.requests).toEqual([]);
  });
});
