import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-server-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

import type { ConfigDocument, SystemInfo } from "@/lib/agent-types";

const GIB = 1024 ** 3;
const limits = { memory: 2 * GIB, cpus: 4, timeout_seconds: 1800, max_source: GIB, source_hosts: ["codeload.github.com"], host_network: false, keep_images: 3 };
const system = (extra: Partial<SystemInfo> = {}): SystemInfo => ({ time: "", host: { cpus: 4 }, os: "linux", arch: "amd64", build: { enabled: true, limits }, ...extra });

/** What each server's agent answers: its apps file and its system report. A server not listed does not answer. */
const agents = { docs: new Map<string, ConfigDocument>(), systems: new Map<string, SystemInfo | null>() };
vi.mock("@/lib/agent", () => ({
  AgentError: class AgentError extends Error {},
  agentFor: (creds: { id: string }) => ({
    config: async () => agents.docs.get(creds.id) ?? null,
    system: async () => agents.systems.get(creds.id) ?? null,
  }),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);

const { db } = await import("@/lib/db");
const { setBuildServerAction } = await import("@/app/github-actions");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

let runs = "";
let mac = "";
let noSecret = "";
beforeAll(() => {
  mac = servers.createServer({ name: "marc-mac", url: "https://mac.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  runs = servers.createServer({ name: "vps-1", url: "https://vps-1.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  noSecret = servers.createServer({ name: "readonly", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const doc = (build: object | undefined): ConfigDocument => ({ model: { apps: [{ name: "shop", image: "keelson-local/shop", ...(build ? { build } : {}) }] } }) as unknown as ConfigDocument;

beforeEach(() => {
  resetStepUp();
  for (const table of ["app_repos", "audit_log"]) db().exec(`DELETE FROM ${table}`);
  agents.docs.clear();
  agents.systems.clear();
  agents.docs.set(runs, doc({ preset: "node", memory: "1g" }));
  agents.systems.set(runs, system());
  agents.systems.set(mac, system({ arch: "arm64" }));
  integrations.setAppRepo(runs, "shop", { repo: "acme/shop", branch: "main" });
});

const form = (builder?: string) => {
  const f = new FormData();
  if (builder !== undefined) f.set("builder", builder);
  return f;
};
const events = () => store.recentAudit(20).map((e) => `${e.event}: ${e.detail}`);

describe("setBuildServerAction", () => {
  it("builds on a server that takes builds within its limits: the server id is stored and audited", async () => {
    expect(await setBuildServerAction(runs, "shop", {}, form(mac))).toEqual({ ok: true });
    expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBe(mac);
    expect(events()).toEqual(["build_server_set: shop: built on marc-mac"]);
  });

  it("goes back to the app's own server with an empty choice, and says so only when it changed", async () => {
    integrations.setBuildOn(runs, "shop", mac);
    expect(await setBuildServerAction(runs, "shop", {}, form(""))).toEqual({ ok: true });
    expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
    await setBuildServerAction(runs, "shop", {}, form(""));
    expect(events()).toEqual(["build_server_set: shop: built on its own server"]);
  });

  it("refuses an agent without the build section: update the agent", async () => {
    agents.systems.set(mac, system({ build: undefined }));
    const r = await setBuildServerAction(runs, "shop", {}, form(mac));
    expect(r.error).toMatch(/Update the agent on marc-mac/);
    expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
  });

  it("refuses a server that does not answer", async () => {
    agents.systems.delete(mac);
    expect((await setBuildServerAction(runs, "shop", {}, form(mac))).error).toMatch(/not answering/);
  });

  it("refuses a server whose limits the app's build block is above, naming the limit", async () => {
    agents.systems.set(mac, system({ build: { enabled: true, limits: { ...limits, memory: GIB / 2 } } }));
    const r = await setBuildServerAction(runs, "shop", {}, form(mac));
    expect(r.error).toContain("build.memory 1g");
    expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
  });

  it("refuses an app without a build block", async () => {
    agents.docs.set(runs, doc(undefined));
    expect((await setBuildServerAction(runs, "shop", {}, form(mac))).error).toMatch(/no build: block/);
  });

  it("refuses a server with no deploy secret, the app's own server and a server it does not know", async () => {
    agents.systems.set(noSecret, system());
    expect((await setBuildServerAction(runs, "shop", {}, form(noSecret))).error).toMatch(/deploy secret/);
    expect((await setBuildServerAction(runs, "shop", {}, form(runs))).error).toMatch(/not registered/);
    expect((await setBuildServerAction(runs, "shop", {}, form("nope"))).error).toMatch(/not registered/);
    expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
  });

  it("refuses an app that is not linked to a repository", async () => {
    integrations.removeAppRepo(runs, "shop");
    expect((await setBuildServerAction(runs, "shop", {}, form(mac))).error).toMatch(/Link this app/);
  });

  describe("when the session is not unlocked", () => {
    beforeEach(() => {
      state.locked = true;
    });

    it("refuses another server as the builder, which would be sent the source and a GitHub token, and stores nothing", async () => {
      const out = await setBuildServerAction(runs, "shop", {}, form(mac));
      expect(isStepUpError(out.error)).toBe(true);
      expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
      expect(events()).toEqual([]);
      state.locked = false;
      expect(await setBuildServerAction(runs, "shop", {}, form(mac))).toEqual({ ok: true });
    });

    it("lets an app go back to its own server: nothing is sent anywhere", async () => {
      integrations.setBuildOn(runs, "shop", mac);
      expect(await setBuildServerAction(runs, "shop", {}, form(""))).toEqual({ ok: true });
      expect(integrations.getAppRepo(runs, "shop")?.buildOn).toBeNull();
    });
  });
});
