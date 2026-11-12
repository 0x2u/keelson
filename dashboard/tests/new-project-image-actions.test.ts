import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigDocument, DeployTarget, EnvChange, SaveOptions, SaveResult } from "@/lib/agent-types";
import type { ImageProjectInput } from "@/lib/new-project-image-core";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-image-project-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const sessions: string[] = [];
let anonymous = false;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    sessions.push("checked");
    if (anonymous) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: url });
  },
}));
vi.mock("@/lib/domain-probe", async (importActual) => ({ ...(await importActual<typeof import("@/lib/domain-probe")>()), resolveAll: async () => ["203.0.113.7"] }));

const agent = {
  doc: null as ConfigDocument | null,
  saved: [] as { name: string; app: AppConfig; opts: SaveOptions }[],
  saveResult: { ok: true, hash: "h2", issues: [] } as SaveResult,
  envCalls: [] as { app: string; change: EnvChange }[],
  deployCalls: [] as { app: string; target: DeployTarget }[],
  deployError: null as Error | null,
  order: [] as string[],
};
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  agentFor: () => ({
    config: async () => agent.doc,
    saveApp: async (name: string, app: AppConfig, opts: SaveOptions) => {
      agent.order.push("config");
      agent.saved.push({ name, app, opts });
      return agent.saveResult;
    },
    supportsEnv: async () => true,
    setEnv: async (app: string, change: EnvChange) => {
      agent.order.push("env");
      agent.envCalls.push({ app, change });
      return { ok: true, changed: Object.keys(change.set ?? {}), removed: [] };
    },
    deploy: async (app: string, target: DeployTarget) => {
      agent.order.push("deploy");
      agent.deployCalls.push({ app, target });
      if (agent.deployError) throw agent.deployError;
      return "dep-7";
    },
  }),
}));

const { db } = await import("@/lib/db");
const actions = await import("@/app/new-project-actions");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const MANUAL = { create: false, proxied: true };
let local = "";
let remote = "";
let readOnly = "";
beforeAll(() => {
  local = servers.createServer({ name: "this-machine", url: "http://127.0.0.1:7071", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  remote = servers.createServer({ name: "vps", url: "https://203.0.113.9:7443", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnly = servers.createServer({ name: "ro", url: "https://ro.example.com", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  resetStepUp();
  for (const table of ["app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  // No GitHub App: this door must work without one.
  integrations.removeGithubApp();
  sessions.length = 0;
  anonymous = false;
  agent.saved = [];
  agent.saveResult = { ok: true, hash: "h2", issues: [] };
  agent.envCalls = [];
  agent.deployCalls = [];
  agent.deployError = null;
  agent.order = [];
  agent.doc = { content: "", hash: "h1", modified_at: "", applied_hash: "h1", deprecations: [], model: { apps: [] } };
});

const input = (extra: Partial<ImageProjectInput> = {}): ImageProjectInput => ({ name: "whoami", image: "traefik/whoami:v1.10.3", port: "80", domain: "", hostPort: "8100", open: false, healthPath: "", ...extra });

describe("createImageProjectAction", () => {
  it("needs a session and no GitHub: it writes the app, deploys the tag, audits both and says how to open it", async () => {
    const out = await actions.createImageProjectAction(local, input(), MANUAL);
    expect(sessions).toEqual(["checked"]);
    expect(agent.order).toEqual(["config", "deploy"]);
    expect(agent.saved[0]).toMatchObject({ name: "whoami", app: { image: "traefik/whoami", restart: "unless-stopped", publish: ["127.0.0.1:8100:80"] }, opts: { base_hash: "h1" } });
    expect(agent.deployCalls).toEqual([{ app: "whoami", target: { tag: "v1.10.3" } }]);
    expect(out.deploymentId).toBe("dep-7");
    expect(out.reach).toMatchObject({ kind: "local", address: "127.0.0.1:8100", url: "http://127.0.0.1:8100" });
    expect(store.recentAudit(20).map((e) => e.event).reverse()).toEqual(["app_created_from_image", "first_deploy_started"]);
  });

  it("does not redirect: the page shows how to reach the app", async () => {
    await expect(actions.createImageProjectAction(local, input(), MANUAL)).resolves.toMatchObject({ deploymentId: "dep-7" });
  });

  it("gives a loopback port of another machine no link, and a port opened to the network the server's address", async () => {
    expect((await actions.createImageProjectAction(remote, input(), MANUAL)).reach).toMatchObject({ address: "127.0.0.1:8100", url: null, loopback: true });
    agent.doc = { ...agent.doc!, model: { apps: [] } };
    const open = await actions.createImageProjectAction(remote, input({ name: "whoami2", open: true }), MANUAL);
    expect(open.reach).toMatchObject({ address: "203.0.113.9:8100", url: "http://203.0.113.9:8100", loopback: false });
    expect(agent.saved[1]!.app.publish).toEqual(["0.0.0.0:8100:80"]);
  });

  it("asks for the unlock before anything: refused, nothing is written or deployed", async () => {
    state.locked = true;
    const out = await actions.createImageProjectAction(local, input(), MANUAL, [{ key: "A", value: "1", build: false }]);
    expect(isStepUpError(out.steps.config.detail)).toBe(true);
    expect(out.steps.config.state).toBe("failed");
    expect(agent.order).toEqual([]);
    expect(state.asked).toHaveLength(1);
    const verdict = state.asked[0]!.verdict;
    expect(verdict.required).toBe(true);
    expect(verdict.required && verdict.reason).toMatch(/Creating the project "whoami" writes an app and its variables/);
  });

  it("sets variables between the write and the deployment, and keeps their values out of the audit log and the outcome", async () => {
    const out = await actions.createImageProjectAction(local, input(), MANUAL, [{ key: "TOKEN", value: "hunter2-secret", build: false }]);
    expect(agent.order).toEqual(["config", "env", "deploy"]);
    expect(agent.envCalls[0]!.change.set).toEqual({ TOKEN: "hunter2-secret" });
    const text = JSON.stringify([out, store.recentAudit(20)]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("s".repeat(40));
  });

  it("returns what is done when the deploy cannot start, and the retry then only deploys", async () => {
    agent.deployError = new Error("a deployment is already running");
    const out = await actions.createImageProjectAction(local, input(), MANUAL);
    expect(out.steps.config.state).toBe("done");
    expect(out.steps.build.state).toBe("failed");
    expect(out.retry).toBe("build");

    agent.doc = { ...agent.doc!, model: { apps: [{ name: "whoami", image: "traefik/whoami", publish: ["127.0.0.1:8100:80"] }] } };
    agent.deployError = null;
    const again = await actions.retryImageProjectAction(local, input(), "build", MANUAL);
    expect(again.deploymentId).toBe("dep-7");
    expect(agent.saved).toHaveLength(1);
  });

  it("refuses a server with no deploy secret, an unknown one, and one that does not serve traffic, writing nothing", async () => {
    expect((await actions.createImageProjectAction(readOnly, input(), MANUAL)).steps.config.detail).toMatch(/read-only here/);
    expect((await actions.createImageProjectAction("nope", input(), MANUAL)).steps.config.detail).toMatch(/Unknown server/);
    const mac = servers.createRelayServer({ name: "marc-mac", token: "t".repeat(40), deploySecret: "s".repeat(40), credentialHash: "h", serves: false }).id;
    expect((await actions.createImageProjectAction(mac, input(), MANUAL)).steps.config.detail).toMatch(/does not serve traffic/);
    expect(agent.order).toEqual([]);
  });

  it("does nothing without a session", async () => {
    anonymous = true;
    await expect(actions.createImageProjectAction(local, input(), MANUAL)).rejects.toThrow("NO_SESSION");
    await expect(actions.retryImageProjectAction(local, input(), "build", MANUAL)).rejects.toThrow("NO_SESSION");
    expect(agent.order).toEqual([]);
  });

  it("asks for the unlock to retry too", async () => {
    state.locked = true;
    const out = await actions.retryImageProjectAction(local, input(), "build", MANUAL);
    expect(isStepUpError(out.steps.config.detail)).toBe(true);
    expect(agent.order).toEqual([]);
  });
});
