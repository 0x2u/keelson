import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeCloudflare } from "./fake-cloudflare";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-isolation-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

/** The request of an API client: a valid bearer token, and no session cookie. */
const request = { authorization: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ authorization: request.authorization }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: url });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/github-webhook", () => ({ startBuild: async () => ({ ok: false, error: "never" }) }));

const { db } = await import("@/lib/db");
const tokens = await import("@/lib/api-tokens");
const servers = await import("@/lib/servers");
const integrations = await import("@/lib/integrations");
const domains = await import("@/app/domain-actions");
const createProject = await import("@/app/new-project-actions");
const serverActions = await import("@/app/actions");
const { serverView } = await import("@/lib/api-v1-views");

const cf = new FakeCloudflare();
let server = "";
beforeAll(() => {
  server = servers.createServer({ name: "prod", url: "https://203.0.113.7:8443", token: "t".repeat(40), deploySecret: "s".repeat(40), publicIp: "203.0.113.7" });
  integrations.saveGithubApp({ appId: "1", slug: null, privateKey: "k" });
  integrations.saveCloudflare(cf.token, { tokenId: "t1", expiresOn: null });
  vi.stubGlobal("fetch", cf.fetch);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const redirectedToLogin = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ message: "NEXT_REDIRECT", redirectTo: "/login" });
};

describe("an API token and the domain features", () => {
  it("cannot reach any action: a valid deploy-scope token without a session is sent to the sign-in, and nothing happens", async () => {
    const { token } = tokens.createApiToken({ name: "ci", scope: "deploy", servers: null, days: 30 });
    request.authorization = `Bearer ${token}`;
    const form = new FormData();
    form.set("token", cf.token);
    form.set("password", "operator-password-1");
    const writes = db().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };

    await redirectedToLogin(domains.connectCloudflareAction({}, form));
    await redirectedToLogin(domains.disconnectCloudflareAction({}, form));
    await redirectedToLogin(domains.checkDomainAction(server, "shop.example.com"));
    await redirectedToLogin(domains.ensureDnsAction(server, "shop.example.com", { proxied: true }));
    await redirectedToLogin(createProject.createProjectAction(server, "acme/shop", {} as never, { create: true, proxied: true }));
    await redirectedToLogin(createProject.retryCreateProjectAction(server, "acme/shop", {} as never, "dns", { create: true, proxied: true }));

    expect(cf.calls).toEqual([]); // not one request to Cloudflare
    expect(integrations.cloudflareToken()).toBe(cf.token); // the stored token is untouched
    expect((db().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(writes.n);
  });

  it("is not given the address, the Cloudflare connection or the token by the API's view of a server", () => {
    const s = servers.getServer(server)!;
    expect(s.publicIp).toBe("203.0.113.7");
    const view = serverView(s, { scope: "deploy" }, { online: true, agentVersion: "1", updateAvailable: false });
    expect(Object.keys(view).sort()).toEqual(["agent_version", "can_deploy", "id", "name", "online", "update_available", "url"]);
    expect(JSON.stringify(view)).not.toContain("cloudflare");
  });

  it("is not offered by a single route of /api/v1, nor by the MCP server: none of their code mentions Cloudflare, DNS records or domain checks", () => {
    const roots = [path.join(__dirname, "..", "app", "api"), path.join(__dirname, "..", "..", "mcp", "src")];
    const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(path.join(p, f))) : /\.(ts|tsx)$/.test(p) ? [p] : []);
    const files = roots.flatMap(walk);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/cloudflare|domain-actions|domain-status|dns-record|domain-probe|lib\/domains|ensureDns|checkDomain/i);
    }
  });

  it("is not offered by the shared API-token code either: the v1 helpers import nothing of it", () => {
    const lib = path.join(__dirname, "..", "lib");
    for (const file of readdirSync(lib).filter((f) => /^api-(v1|tokens)/.test(f))) {
      expect(readFileSync(path.join(lib, file), "utf8"), file).not.toMatch(/cloudflare|domain-status|dns-record|domain-probe|lib\/domains/i);
    }
  });

  it("does not let a token change a server's public address either: that is the session-only server settings action", async () => {
    const before = servers.getServer(server)!.publicIp;
    const form = new FormData();
    for (const [k, v] of Object.entries({ name: "prod", url: "https://203.0.113.7:8443", publicIp: "198.51.100.1" })) form.set(k, v);
    await redirectedToLogin(serverActions.updateServerAction(server, {}, form));
    expect(servers.getServer(server)!.publicIp).toBe(before);
  });
});
