import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-connect-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({
  requireSession: async () => {},
  currentSession: async () => ({ id: "s1" }),
  hasSession: async () => true,
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "keelson.example.com" }) }));

const { db } = await import("@/lib/db");
const integrations = await import("@/lib/integrations");
const github = await import("@/lib/github-app");
const actions = await import("@/app/github-actions");
const { default: IntegrationsPage } = await import("@/app/(app)/settings/integrations/page");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });

beforeEach(() => {
  for (const table of ["integrations", "app_repos", "audit_log"]) db().exec(`DELETE FROM ${table}`);
  github.invalidateInstalledRepos();
  process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com";
  vi.unstubAllGlobals();
});

/** GitHub with the given installations (each: id and repositories). */
function stubGithub(installations: { id: number; repos: { full_name: string; private: boolean }[] }[], status = 200) {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (status !== 200) return new Response("{}", { status });
    if (u.pathname === "/app") return Response.json({ slug: "my-keelson" });
    if (u.pathname === "/app/installations") return Response.json(installations.map((i) => ({ id: i.id, account: { login: "me" } })));
    const mint = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) return Response.json({ token: `ghs_${mint[1]}` }, { status: 201 });
    if (u.pathname === "/installation/repositories") {
      const id = Number(String((init?.headers as Record<string, string>).Authorization).replace("Bearer ghs_", ""));
      return Response.json({ repositories: installations.find((i) => i.id === id)?.repos.map((r) => ({ ...r, default_branch: "main" })) ?? [] });
    }
    return new Response("{}", { status: 404 });
  });
}

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await IntegrationsPage({ searchParams: Promise.resolve(query) }));
}

/** An App as the manifest flow stores it. */
const connectedApp = () => integrations.saveGithubApp({ appId: "4242", slug: "keelson-ab", privateKey: keys.privateKey, name: "Keelson ab", owner: { login: "acme", type: "Organization" } });
const advanced = (html: string) => html.slice(html.indexOf("Advanced / manual setup"));
const main = (html: string) => html.slice(0, html.indexOf("Advanced / manual setup"));

describe("the Integrations page", () => {
  it("(a) with nothing configured shows only Connect GitHub in the main flow, and the manual path under Advanced", async () => {
    const html = await render();
    expect(main(html)).toContain("Connect GitHub");
    expect(main(html)).toContain("Name of the GitHub App");
    expect(main(html)).toContain("My GitHub account");
    expect(main(html)).toContain("An organization");
    expect(main(html)).not.toContain("Install the App");
    expect(main(html)).not.toContain("Disconnect");
    expect(main(html)).not.toContain("Payload URL");
    expect(main(html)).not.toContain("Paste the App ID");
    expect(html).toMatch(/Name of the GitHub App[\s\S]*value="Keelson [0-9a-f]{6}"/);
    // Everything manual is still there, in the collapsed section.
    const manual = advanced(html);
    for (const text of ["Create the App with the least access it needs", "Save the App", "Fine-grained access token", "GitHub webhook", "Generate a secret", "Payload URL"]) expect(manual, text).toContain(text);
  });

  it("(a) without a public https address says what to set and offers no button", async () => {
    delete process.env.KEELSON_PUBLIC_URL;
    const html = main(await render());
    expect(html).toContain("KEELSON_PUBLIC_URL");
    expect(html).not.toContain("Name of the GitHub App");
  });

  it("(b) with the App set but not installed, asks to install it and offers a refresh", async () => {
    connectedApp();
    stubGithub([]);
    const html = main(await render());
    expect(html).toContain("Install the App to choose repositories");
    expect(html).toContain('href="https://github.com/apps/keelson-ab/installations/new"');
    expect(html).toContain("Refresh");
    expect(html).toContain("Not installed yet");
    expect(html).not.toContain("Installed repositories");
    expect(html).not.toContain("Name of the GitHub App");
  });

  it("(c) with the App installed shows its name, owner, settings link, the repositories with private badges, more-repositories link and Disconnect", async () => {
    connectedApp();
    stubGithub([{ id: 1, repos: [{ full_name: "acme/shop", private: true }, { full_name: "acme/site", private: false }] }]);
    const html = main(await render());
    expect(html).toContain("Keelson ab");
    expect(html).toContain("owned by acme");
    expect(html).toContain('href="https://github.com/organizations/acme/settings/apps/keelson-ab"');
    expect(html).toContain("2 installed repositories");
    expect(html).toContain('href="/projects/new"');
    expect(html).toContain("New project");
    expect(html).not.toContain("Add app from GitHub");
    expect(html).toContain("acme/shop");
    expect(html).toContain("acme/site");
    expect(html.match(/private/g)).toHaveLength(1);
    expect(html).toContain('href="https://github.com/apps/keelson-ab/installations/new"');
    expect(html).toContain("Install on more repositories");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Connected");
    expect(html).not.toContain("Install the App to choose repositories");
  });

  it("(c) shows a GitHub failure with its cause instead of pretending the App is not installed", async () => {
    connectedApp();
    stubGithub([], 401);
    const html = main(await render());
    expect(html).toContain("Could not ask GitHub about the installations");
    expect(html).toContain("rejected the App&#x27;s credentials");
    expect(html).not.toContain("Install the App to choose repositories");
  });

  it("shows the fixed sentence of a failed connection, never text from the address", async () => {
    expect(main(await render({ github_error: "expired_state" }))).toContain("more than 10 minutes ago");
    const html = main(await render({ github_error: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("did not finish");
  });

  it("looks at GitHub again when returning from the installation, instead of using a minute-old listing", async () => {
    connectedApp();
    stubGithub([]);
    expect(main(await render())).toContain("Install the App to choose repositories");
    stubGithub([{ id: 1, repos: [{ full_name: "acme/shop", private: false }] }]);
    expect(main(await render())).toContain("Install the App to choose repositories");
    const html = main(await render({ github: "installed" }));
    expect(html).toContain("acme/shop");
    expect(html).toContain("The App is installed");
  });

  it("the Advanced section still saves manual credentials, and the page then shows them there", async () => {
    stubGithub([]);
    const f = new FormData();
    f.set("appId", "999");
    f.set("privateKey", keys.privateKey);
    expect(await actions.saveGithubAppAction({}, f)).toEqual({ ok: true });
    expect(integrations.githubAppSummary()).toMatchObject({ appId: "999", slug: "my-keelson" });
    const html = await render();
    expect(advanced(html)).toContain("App ID <span");
    expect(advanced(html)).toContain("999");
    expect(main(html)).toContain("Install the App to choose repositories");
  });

  it("forgets the listing when the App is removed, so a new App is never shown the old repositories", async () => {
    connectedApp();
    stubGithub([{ id: 1, repos: [{ full_name: "acme/shop", private: false }] }]);
    expect(main(await render())).toContain("acme/shop");
    await actions.removeGithubAppAction();
    const html = main(await render());
    expect(html).not.toContain("acme/shop");
    expect(html).toContain("Connect GitHub");
  });
});
