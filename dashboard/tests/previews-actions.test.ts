import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/lib/agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-previews-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const deletes: { app: string; pr: number }[] = [];
let deleteError: AgentError | null = null;
let previewsError: AgentError | null = null;
let instances: { app: string; pr: number }[] = [];
vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/agent", async (original) => ({
  ...(await original<typeof import("@/lib/agent")>()),
  agentFor: () => ({
    previews: async () => {
      if (previewsError) throw previewsError;
      return instances;
    },
    deletePreview: async (app: string, pr: number) => {
      if (deleteError) throw deleteError;
      deletes.push({ app, pr });
    },
  }),
}));

const { db } = await import("@/lib/db");
const actions = await import("@/app/github-actions");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let server = "";
beforeAll(() => {
  server = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["app_repos", "audit_log"]) db().exec(`DELETE FROM ${table}`);
  deletes.length = 0;
  deleteError = null;
  previewsError = null;
  instances = [];
  integrations.setAppRepo(server, "shop", { repo: "acme/shop", branch: "main" });
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const events = () => store.recentAudit(50).map((e) => `${e.event}: ${e.detail}`);

describe("setPreviewsAction", () => {
  it("turns previews on for the named workflow, and audits it", async () => {
    expect(await actions.setPreviewsAction(server, "shop", {}, form({ enabled: "on", workflow: " Build and push " }))).toEqual({ ok: true });
    expect(integrations.getAppRepo(server, "shop")?.previewsWorkflow).toBe("Build and push");
    expect(events()).toEqual(['previews_on: shop <- acme/shop@main, workflow "Build and push"']);
  });

  it("turns them off without touching automatic deploys, and audits only a real change", async () => {
    integrations.setAutoDeployWorkflow(server, "shop", "Deploy");
    integrations.setPreviewsWorkflow(server, "shop", "Build");
    await actions.setPreviewsAction(server, "shop", {}, form({ workflow: "Build" }));
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ previewsWorkflow: null, autoDeployWorkflow: "Deploy" });
    await actions.setPreviewsAction(server, "shop", {}, form({}));
    expect(events()).toEqual(["previews_off: shop <- acme/shop@main"]);
  });

  it("removes the running previews of the app when asked, and audits the count", async () => {
    integrations.setPreviewsWorkflow(server, "shop", "Build");
    instances = [{ app: "shop", pr: 3 }, { app: "other", pr: 4 }, { app: "shop", pr: 9 }];
    expect(await actions.setPreviewsAction(server, "shop", {}, form({ removePreviews: "on" }))).toEqual({ ok: true });
    expect(deletes).toEqual([{ app: "shop", pr: 3 }, { app: "shop", pr: 9 }]);
    expect(integrations.getAppRepo(server, "shop")?.previewsWorkflow).toBeNull();
    expect(events()).toEqual(["previews_off: shop <- acme/shop@main, removed 2 of 2 previews"]);
  });

  it("leaves the previews running when the removal is not asked for", async () => {
    integrations.setPreviewsWorkflow(server, "shop", "Build");
    instances = [{ app: "shop", pr: 3 }];
    await actions.setPreviewsAction(server, "shop", {}, form({}));
    expect(deletes).toEqual([]);
  });

  it("still switches previews off, and says so, when the agent cannot be reached or a removal fails", async () => {
    integrations.setPreviewsWorkflow(server, "shop", "Build");
    previewsError = new AgentError(0, "agent unreachable");
    const unreachable = await actions.setPreviewsAction(server, "shop", {}, form({ removePreviews: "on" }));
    expect(unreachable).toMatchObject({ ok: true, notice: expect.stringContaining("agent unreachable") });
    expect(integrations.getAppRepo(server, "shop")?.previewsWorkflow).toBeNull();

    integrations.setPreviewsWorkflow(server, "shop", "Build");
    previewsError = null;
    instances = [{ app: "shop", pr: 3 }];
    deleteError = new AgentError(409, "a deployment of this preview is running");
    const failed = await actions.setPreviewsAction(server, "shop", {}, form({ removePreviews: "on" }));
    expect(failed).toMatchObject({ ok: true, notice: expect.stringContaining("1 of 1 could not be removed") });
    expect(integrations.getAppRepo(server, "shop")?.previewsWorkflow).toBeNull();
    expect(events()).toContain("previews_off: shop <- acme/shop@main, removed 0 of 1 previews");
  });

  it("refuses an empty or malformed workflow name and an app with no link", async () => {
    expect(await actions.setPreviewsAction(server, "shop", {}, form({ enabled: "on", workflow: "  " }))).toMatchObject({ error: expect.stringContaining("workflow") });
    expect(await actions.setPreviewsAction(server, "shop", {}, form({ enabled: "on", workflow: "bad\nname" }))).toMatchObject({ error: expect.stringContaining("workflow name") });
    expect(await actions.setPreviewsAction(server, "shop", {}, form({ enabled: "on", workflow: "x".repeat(201) }))).toMatchObject({ error: expect.stringContaining("workflow name") });
    expect(await actions.setPreviewsAction(server, "other", {}, form({ enabled: "on", workflow: "Build" }))).toEqual({ error: "Link this app to a repository first." });
    expect(integrations.getAppRepo(server, "shop")?.previewsWorkflow).toBeNull();
    expect(events()).toEqual([]);
  });
});

describe("deletePreviewAction", () => {
  it("asks the agent to remove the preview and audits it", async () => {
    expect(await actions.deletePreviewAction(server, "shop", 12)).toEqual({ ok: true });
    expect(deletes).toEqual([{ app: "shop", pr: 12 }]);
    expect(events()).toEqual(["preview_removed: shop-pr-12 on staging"]);
  });

  it("refuses an unknown server and a pull request number out of range, before asking anyone", async () => {
    expect(await actions.deletePreviewAction("nope", "shop", 12)).toEqual({ error: "Unknown server." });
    for (const pr of [0, -1, 1.5, 1_000_000]) expect(await actions.deletePreviewAction(server, "shop", pr)).toEqual({ error: "That is not a pull request number." });
    expect(deletes).toEqual([]);
  });

  it("shows the agent's reason when it refuses, and audits nothing", async () => {
    deleteError = new AgentError(409, "a deployment of this preview is running");
    expect(await actions.deletePreviewAction(server, "shop", 12)).toEqual({ error: "a deployment of this preview is running" });
    expect(events()).toEqual([]);
  });
});
