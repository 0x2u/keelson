import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

// The actions the review of 0.1.0-rc1 found without the unlock (M1): each is refused, and changes nothing, while the session
// is locked; the same call works once it is unlocked. (The wizard, the DNS rule, the enrolment, the connect code, the build
// server and the GitHub App connection are tested with their own actions.)

const dir = mkdtempSync(path.join(tmpdir(), "keelson-step-up-gaps-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, currentSession: async () => ({ id: "s" }), clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  probeAgent: async () => ({}),
}));
vi.mock("@/lib/github", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/github")>()),
  githubCommits: async () => [],
}));
vi.mock("@/lib/github-app", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/github-app")>()),
  installationToken: async () => "installation-token",
}));

const { db } = await import("@/lib/db");
const servers = await import("@/lib/servers");
const integrations = await import("@/lib/integrations");
const { importServersAction } = await import("@/app/server-import-actions");
const { savePublicIpAction } = await import("@/app/public-ip-actions");
const { generateWebhookSecretAction, linkRepoAction } = await import("@/app/github-actions");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

let web = "";
beforeAll(() => {
  web = servers.createServer({ name: "web", url: "https://web.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
beforeEach(() => {
  resetStepUp();
  for (const table of ["app_repos", "audit_log", "integrations"]) db().exec(`DELETE FROM ${table}`);
  db().exec("DELETE FROM servers WHERE name <> 'web'");
  servers.updateServer(web, { name: "web", url: "https://web.example.com", caCert: "", clientCert: "", publicIp: "" });
  integrations.saveGithubApp({ appId: "1", slug: "keelson", privateKey: "KEY" });
});

describe("importServersAction", () => {
  const file = JSON.stringify({ servers: [{ name: "attacker", url: "https://evil.example.net:7070", token: "t".repeat(40), deploy_secret: "d".repeat(40) }] });

  it("registers nothing while the session is locked, even when it would keep a server that does not answer", async () => {
    state.locked = true;
    const out = await importServersAction(file, true);
    expect(out.ok).toBe(false);
    expect(!out.ok && isStepUpError(out.error)).toBe(true);
    expect(servers.listServers().map((s) => s.name)).toEqual(["web"]);
    state.locked = false;
    expect((await importServersAction(file, true)).ok).toBe(true);
    expect(servers.listServers().map((s) => s.name).sort()).toEqual(["attacker", "web"]);
  });
});

describe("savePublicIpAction", () => {
  it("does not move the address the DNS records point at while the session is locked", async () => {
    state.locked = true;
    const out = await savePublicIpAction(web, {}, form({ publicIp: "203.0.113.66" }));
    expect(isStepUpError(out.error)).toBe(true);
    expect(servers.getServer(web)?.publicIp).toBeNull();
    state.locked = false;
    expect(await savePublicIpAction(web, {}, form({ publicIp: "203.0.113.66" }))).toEqual({ saved: "203.0.113.66" });
  });

  it("lets the same address be saved again, and the address be cleared, without the unlock", async () => {
    await savePublicIpAction(web, {}, form({ publicIp: "203.0.113.66" }));
    state.locked = true;
    expect(await savePublicIpAction(web, {}, form({ publicIp: "203.0.113.66" }))).toEqual({ saved: "203.0.113.66" });
    expect(await savePublicIpAction(web, {}, form({ publicIp: "" }))).toEqual({ saved: "" });
  });
});

describe("generateWebhookSecretAction", () => {
  it("gives no secret while the session is locked, and leaves the current one working", async () => {
    const first = await generateWebhookSecretAction();
    expect(first.secret).toBeDefined();
    const since = integrations.webhookSecretSince();
    state.locked = true;
    const out = await generateWebhookSecretAction();
    expect(out.secret).toBeUndefined();
    expect(isStepUpError(out.error)).toBe(true);
    expect(integrations.webhookSecretSince()).toBe(since);
    state.locked = false;
    expect((await generateWebhookSecretAction()).secret).toBeDefined();
  });
});

describe("linkRepoAction", () => {
  const link = (repo: string, branch = "main") => linkRepoAction(web, "shop", {}, form({ repo, branch }));

  it("does not point an app at another repository or branch while the session is locked", async () => {
    await link("acme/shop");
    state.locked = true;
    expect(isStepUpError((await link("acme/other")).error)).toBe(true);
    expect(isStepUpError((await link("acme/shop", "evil")).error)).toBe(true);
    expect(integrations.getAppRepo(web, "shop")).toMatchObject({ repo: "acme/shop", branch: "main" });
  });

  it("links a first time only after the unlock, and re-saving the same link needs nothing", async () => {
    state.locked = true;
    expect(isStepUpError((await link("acme/shop")).error)).toBe(true);
    expect(integrations.getAppRepo(web, "shop")).toBeNull();
    state.locked = false;
    expect(await link("acme/shop")).toEqual({ ok: true });
    state.locked = true;
    expect(await link("acme/shop")).toEqual({ ok: true });
  });
});
