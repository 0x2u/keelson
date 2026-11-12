import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const actions = await import("@/app/github-actions");
const integrations = await import("@/lib/integrations");
const deliveries = await import("@/lib/webhook-deliveries");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { GithubAppCard } = await import("@/components/repository/GithubAppCard");
const { BuildCard } = await import("@/components/repository/BuildCard");
const { AutoDeployCard } = await import("@/components/repository/AutoDeployCard");
const { GithubWebhookCard } = await import("@/components/repository/GithubWebhookCard");
const { installationTokens } = await import("@/lib/github-app");

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const SHA = "a".repeat(40);

let server = "";
beforeAll(() => {
  server = servers.createServer({ name: "staging", url: "https://stg.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["app_repos", "audit_log", "integrations", "webhook_deliveries"]) db().exec(`DELETE FROM ${table}`);
  vi.unstubAllGlobals();
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** A GitHub that answers GET /app (and records how it was asked). */
function stubGithub(status = 200) {
  const asked: { url: string; auth: string }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization) });
    return status === 200 ? Response.json({ slug: "my-keelson" }) : new Response("{}", { status });
  });
  return asked;
}

describe("saving the GitHub App", () => {
  it("checks the credentials with GitHub, stores the key encrypted, learns the slug, audits without the key, and never returns the key", async () => {
    const asked = stubGithub();
    const out = await actions.saveGithubAppAction({}, form({ appId: "4242", privateKey: keys.privateKey, slug: "" }));
    expect(out).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://api.github.com/app");
    expect(asked[0]!.auth).toMatch(/^Bearer /);
    expect(integrations.githubAppSummary()).toMatchObject({ appId: "4242", slug: "my-keelson" });
    expect(integrations.githubAppCredentials()?.privateKey).toBe(keys.privateKey.trim());
    const stored = JSON.stringify(db().prepare("SELECT * FROM integrations").all());
    expect(stored).not.toContain("PRIVATE KEY");
    const audit = JSON.stringify(store.recentAudit(10));
    expect(audit).toContain("github_app_saved");
    expect(audit).not.toContain("PRIVATE KEY");
    expect(audit).not.toContain(keys.privateKey.slice(40, 80));
  });

  it("keeps the operator's slug when one is given", async () => {
    stubGithub();
    await actions.saveGithubAppAction({}, form({ appId: "1", privateKey: keys.privateKey, slug: "chosen-name" }));
    expect(integrations.githubAppSummary()?.slug).toBe("chosen-name");
  });

  it("refuses a bad App ID, a missing or malformed key, a bad slug and a rejection by GitHub, storing nothing", async () => {
    const asked = stubGithub(401);
    const cases: [Record<string, string>, RegExp][] = [
      [{ appId: "abc", privateKey: keys.privateKey }, /App ID/],
      [{ appId: "1", privateKey: "" }, /Paste the private key/],
      [{ appId: "1", privateKey: "not a key" }, /not a private key in PEM format/],
      [{ appId: "1", privateKey: keys.privateKey, slug: "a/b" }, /App's name/],
      [{ appId: "1", privateKey: "x".repeat(20_000) }, /does not look like a private key/],
      [{ appId: "1", privateKey: keys.privateKey }, /rejected the App's credentials/],
    ];
    for (const [fields, message] of cases) {
      const out = await actions.saveGithubAppAction({}, form(fields));
      expect(out.error, JSON.stringify(fields).slice(0, 40)).toMatch(message);
      expect(out.ok).toBeUndefined();
    }
    expect(asked).toHaveLength(1); // only the last case got as far as GitHub
    expect(integrations.githubAppSummary()).toBeNull();
    expect(JSON.stringify(cases.map(([f]) => f.privateKey))).not.toContain("never");
  });

  it("forgets the cached installation tokens when the App is replaced or removed", async () => {
    const clear = vi.spyOn(installationTokens, "clear");
    stubGithub();
    await actions.saveGithubAppAction({}, form({ appId: "1", privateKey: keys.privateKey }));
    await actions.removeGithubAppAction();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(integrations.githubAppSummary()).toBeNull();
    expect(store.recentAudit(10).map((e) => e.event)).toContain("github_app_removed");
    clear.mockRestore();
  });
});

describe("turning builds on", () => {
  beforeEach(() => {
    integrations.setAppRepo(server, "shop", { repo: "acme/shop", branch: "main" });
  });

  it("needs a linked app and, to turn a mode on, the App", async () => {
    expect(await actions.setBuildModesAction(server, "nothing", {}, form({ onPush: "on" }))).toEqual({ error: "Link this app to a repository first." });
    expect(await actions.setBuildModesAction(server, "shop", {}, form({ onPush: "on" }))).toEqual({ error: "Set up the GitHub App in Integrations first." });
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ buildOnPush: false, buildPreviews: false });
  });

  it("turns each mode on and off with the App set up, and audits the change", async () => {
    integrations.saveGithubApp({ appId: "1", slug: null, privateKey: keys.privateKey });
    expect(await actions.setBuildModesAction(server, "shop", {}, form({ onPush: "on" }))).toEqual({ ok: true });
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ buildOnPush: true, buildPreviews: false });
    expect(await actions.setBuildModesAction(server, "shop", {}, form({ onPush: "on", previews: "on" }))).toEqual({ ok: true });
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ buildOnPush: true, buildPreviews: true });
    expect(await actions.setBuildModesAction(server, "shop", {}, form({}))).toEqual({ ok: true });
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ buildOnPush: false, buildPreviews: false });
    expect(store.recentAudit(10).filter((e) => e.event === "build_modes")).toHaveLength(3);
  });

  it("lets a mode be turned off even when the App is gone", async () => {
    integrations.saveGithubApp({ appId: "1", slug: null, privateKey: keys.privateKey });
    integrations.setBuildModes(server, "shop", { onPush: true, previews: true });
    db().exec("DELETE FROM integrations WHERE provider = 'github-app'");
    expect(await actions.setBuildModesAction(server, "shop", {}, form({ onPush: "on" }))).toEqual({ ok: true }); // kept on, turned previews off
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ buildOnPush: true, buildPreviews: false });
  });
});

describe("linking a repository without a personal token", () => {
  it("proves the repository is reachable through the App's installation", async () => {
    integrations.saveGithubApp({ appId: "1", slug: null, privateKey: keys.privateKey });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith("/installation")) return Response.json({ id: 5 });
      if (String(url).includes("/access_tokens")) return Response.json({ token: "ghs_x" }, { status: 201 });
      return Response.json([{ sha: SHA, commit: { message: "m", author: { name: "a", date: "2026-10-21T10:00:00Z" } }, html_url: "https://github.com/acme/shop/commit/x" }]);
    });
    installationTokens.clear();
    expect(await actions.linkRepoAction(server, "shop", {}, form({ repo: "acme/shop", branch: "main" }))).toEqual({ ok: true });
    expect(integrations.getAppRepo(server, "shop")).toMatchObject({ repo: "acme/shop", branch: "main" });
    expect(urls.some((u) => u.includes("/repos/acme/shop/commits"))).toBe(true);
    installationTokens.clear();
  });

  it("says the App is not installed, and with neither token nor App says to connect GitHub", async () => {
    integrations.saveGithubApp({ appId: "1", slug: null, privateKey: keys.privateKey });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    installationTokens.clear();
    expect((await actions.linkRepoAction(server, "shop", {}, form({ repo: "acme/shop" }))).error).toMatch(/not installed on acme\/shop/);
    expect(integrations.getAppRepo(server, "shop")).toBeNull();
    db().exec("DELETE FROM integrations");
    expect(await actions.linkRepoAction(server, "shop", {}, form({ repo: "acme/shop" }))).toEqual({ error: "Connect GitHub in Settings first." });
  });
});

describe("the GitHub App card", () => {
  const render = (app: Parameters<typeof GithubAppCard>[0]["app"], webhookSecretSet = true) => renderToStaticMarkup(createElement(GithubAppCard, { app, webhookSecretSet }));

  it("asks for the App ID, the key and the optional name, lists the minimum permissions and the events, and warns what a build is", () => {
    const html = render(null);
    expect(html).toContain("Not set up");
    expect(html).toContain('name="appId"');
    expect(html).toContain('name="privateKey"');
    expect(html).toContain('name="slug"');
    for (const word of ["Contents", "Commit statuses", "Pull requests", "Metadata", "Push", "same secret"]) expect(html).toContain(word);
    expect(html).toContain("A build runs the repository&#x27;s Dockerfile on the target server");
    expect(html).toContain("Pull requests from forks never");
    expect(html).toContain("not supported yet");
  });

  it("wires every field to its label and help, and marks only the App name optional", () => {
    const html = render(null);
    expect(html).toMatch(/<label[^>]*for="([^"]+-app)"[^>]*>App ID<\/label>/);
    expect(html).toMatch(/<label[^>]*for="[^"]+-key"/);
    expect(html).toMatch(/aria-describedby="[^"]+-key-help"/);
    expect(html).toMatch(/aria-describedby="[^"]+-slug-help"/);
    expect(html.match(/\(optional\)/g)).toHaveLength(1);
    expect(html).toContain("<form");
    expect(html).toContain("noValidate");
  });

  it("shows only the App ID and that a key is set once configured, never a field holding the key", () => {
    integrations.saveGithubApp({ appId: "4242", slug: "my-keelson", privateKey: keys.privateKey });
    const html = render(integrations.githubAppSummary());
    expect(html).toContain("Configured");
    expect(html).toContain("4242");
    expect(html).toContain("private key set");
    expect(html).toContain('href="https://github.com/apps/my-keelson"');
    expect(html).not.toContain('name="privateKey"');
    expect(html).not.toContain("PRIVATE KEY");
    expect(html).toContain("Replace the credentials");
  });

  it("points at the webhook secret when it is missing", () => {
    expect(render({ appId: "1", slug: null, createdAt: 0 }, false)).toContain("The webhook secret is not set up");
  });

  it("is mentioned by the webhook card, which lists the Push event for the App", () => {
    const html = renderToStaticMarkup(createElement(GithubWebhookCard, { url: "https://d.example.com/api/webhooks/github", since: null }));
    expect(html).toContain("GitHub App");
    expect(html).toContain("Push");
  });
});

/** The opening tag of the input with this name (React does not keep the attributes in the order of the props). */
const input = (html: string, name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "";

describe("the GitHub App build card", () => {
  const render = (over: Partial<Parameters<typeof BuildCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(BuildCard, { serverId: server, app: "shop", appConfigured: true, appSlug: "my-keelson", onPush: false, previews: false, secretSet: true, canDeploy: true, ...over }));

  const row = (over: Partial<Parameters<typeof deliveries.recordDelivery>[0]> = {}) =>
    deliveries.recordDelivery({ deliveryId: "d1", repo: "acme/shop", branch: "main", sha: SHA, serverId: server, app: "shop", outcome: "deployed", detail: "build and deployment started", deploymentId: "dep-1", runKey: `acme/shop#push#${SHA}`, ...over });

  it("shows both switches with their state, the install link and the security copy", () => {
    const html = render({ onPush: true });
    expect(html).toContain("GitHub App build");
    expect(html).toContain('name="onPush"');
    expect(html).toContain('name="previews"');
    expect(input(html, "onPush")).toContain("checked");
    expect(input(html, "previews")).not.toContain("checked");
    expect(html).toContain('href="https://github.com/apps/my-keelson/installations/new"');
    expect(html).toContain("gets no secrets");
    expect(html).toContain("never a fork");
    expect(html).toContain("Nothing received yet");
  });

  it("says the App is not set up, and keeps the switches that are off disabled", () => {
    const html = render({ appConfigured: false, appSlug: null });
    expect(html).toContain("The GitHub App is not set up");
    expect(input(html, "onPush")).toContain("disabled");
    expect(input(html, "previews")).toContain("disabled");
    expect(input(render({ appConfigured: false, appSlug: null, onPush: true }), "onPush")).not.toContain("disabled");
    expect(input(render(), "onPush")).not.toContain("disabled");
  });

  it("warns about the missing webhook secret and a server without a deploy secret", () => {
    const html = render({ secretSet: false, canDeploy: false });
    expect(html).toContain("The GitHub webhook is not set up");
    expect(html).toContain("This server cannot deploy from here");
  });

  it("lists the latest builds of the app and its previews, with the deployment link, and leaves out CI deliveries and other apps", () => {
    row();
    row({ deliveryId: "d2", app: "shop-pr-12", sha: "b".repeat(40), runKey: `acme/shop#pr12#${"b".repeat(40)}`, deploymentId: "dep-2", detail: "preview build and deployment started: https://pr-12" });
    row({ deliveryId: "ci", sha: "c".repeat(40), runKey: "acme/shop#200#1", detail: "deployment started", deploymentId: "dep-ci" });
    row({ deliveryId: "d4", app: "admin", sha: "d".repeat(40), runKey: `acme/shop#push#${"d".repeat(40)}`, deploymentId: "dep-4", detail: "other app" });
    const html = render();
    expect(html).toContain("aaaaaaa");
    expect(html).toContain("shop-pr-12");
    expect(html).toContain("preview build and deployment started");
    expect(html).toContain(`href="/servers/${server}/deployments/dep-1"`);
    expect(html).not.toContain("dep-ci");
    expect(html).not.toContain("other app");
    expect(html).not.toContain("Nothing received yet");
    // The table scrolls inside its block: the block must be allowed to shrink in the card's grid, or the page scrolls sideways on a phone.
    expect(html).toContain('<div class="min-w-0"><h3');
  });

  it("shows the agent's refusal on its own, so a missing build: block is clear", () => {
    row({ outcome: "failed", detail: "the agent cannot build this app: app shop has no build: block", deploymentId: null });
    const html = render();
    expect(html).toContain("This app cannot be built on its agent");
    expect(html).toContain("app shop has no build: block");
  });

  it("keeps builds out of the automatic deploys card's deliveries", () => {
    row();
    row({ deliveryId: "ci", sha: "c".repeat(40), runKey: "acme/shop#200#1", detail: "deployment started", deploymentId: "dep-ci" });
    const html = renderToStaticMarkup(createElement(AutoDeployCard, { serverId: server, app: "shop", workflow: "Build", suggestions: [], secretSet: true, canDeploy: true }));
    expect(html).toContain("ccccccc");
    expect(html).not.toContain("aaaaaaa");
  });
});

describe("the schema upgrade", () => {
  it("adds the build modes, off, to a database at the version before them, keeping links, workflows and deliveries", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase, SCHEMA_VERSION } = await import("@/lib/db");
    const file = path.join(dir, "before-builds.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE servers (id TEXT PRIMARY KEY);
      CREATE TABLE app_repos (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, app TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
        auto_deploy_workflow TEXT, previews_workflow TEXT, PRIMARY KEY (server_id, app)
      );
      INSERT INTO servers (id) VALUES ('s');
      INSERT INTO app_repos (server_id, app, repo, branch, auto_deploy_workflow, previews_workflow) VALUES ('s', 'shop', 'a/b', 'main', 'Build', 'Build');
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY); -- a later migration adds the step-up column to it
      PRAGMA user_version = 7;
    `);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("SELECT app, repo, auto_deploy_workflow, previews_workflow, build_on_push, build_previews FROM app_repos").all()).toEqual([
        { app: "shop", repo: "a/b", auto_deploy_workflow: "Build", previews_workflow: "Build", build_on_push: 0, build_previews: 0 },
      ]);
      expect((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      upgraded.exec("UPDATE app_repos SET build_on_push = 1");
      expect(upgraded.prepare("SELECT build_on_push, build_previews FROM app_repos").get()).toEqual({ build_on_push: 1, build_previews: 0 });
    } finally {
      upgraded.close();
    }
  });
});
