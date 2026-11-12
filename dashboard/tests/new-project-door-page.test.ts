import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectServer } from "@/lib/new-project-wizard-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/new", useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/new-project-actions", () => ({
  createProjectAction: async () => ({}),
  retryCreateProjectAction: async () => ({}),
  inspectRepoAction: async () => ({}),
  createImageProjectAction: async () => ({}),
  retryImageProjectAction: async () => ({}),
}));

const github = { connected: false };
vi.mock("@/lib/integrations", () => ({ githubAppSummary: () => (github.connected ? { appId: "1", slug: "keelson-x" } : null) }));
const loaded = { servers: [] as ProjectServer[] };
vi.mock("@/lib/new-project", () => ({ loadProjectServers: async () => ({ servers: loaded.servers, skipped: [{ id: "s9", name: "offline", reason: "the agent does not answer" }] }) }));
vi.mock("@/lib/github-app", () => ({
  GithubAppError: class extends Error {},
  listInstalledRepos: async () => [{ fullName: "acme/shop", defaultBranch: "main", private: false }],
}));

const { default: NewProjectPage } = await import("@/app/(app)/projects/new/page");

const SERVER: ProjectServer = {
  id: "srv",
  name: "staging",
  context: { existingNames: [], usedDomains: [], usedHostPorts: [], proxy: "none", previewApps: [] },
  hostPort: 8100,
  dns: { connected: false, zones: [], zonesError: null, address: { ok: false, error: "no address" } },
  envSupported: true,
  databaseSupported: true,
  appsDomain: null,
  stats: { online: true },
};

const render = async (query: Record<string, string> = {}) => renderToStaticMarkup(await NewProjectPage({ searchParams: Promise.resolve(query) }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  github.connected = false;
  loaded.servers = [SERVER];
});

describe("New project without GitHub", () => {
  it("shows both doors, the repository one explaining GitHub, the image one usable", async () => {
    const out = await render();
    expect(out).toContain('data-testid="doors"');
    expect(text(out)).toContain("GitHub is not connected yet");
    expect(out).toContain('href="/projects/new?door=image"');
    expect(out).not.toContain("Choose a repository");
  });

  it("opens the image form with no GitHub at all, on the server it was opened for", async () => {
    const out = await render({ door: "image", server: "srv" });
    expect(text(out)).toContain("Describe what to run");
    expect(text(out)).toContain("Image (required)");
    expect(out).not.toContain("GitHub is not connected");
    expect(text(out)).toContain("From an image");
  });

  it("keeps the old repository address meaningful: it says GitHub is needed and offers the image instead", async () => {
    const out = await render({ door: "repository" });
    expect(text(out)).toContain("GitHub is not connected yet");
    expect(out).toContain("Use an image instead");
    expect((await render({ repo: "acme/shop" })).includes("Use an image instead")).toBe(true);
  });

  it("says no server can take the project, with the reason, before any form", async () => {
    loaded.servers = [];
    const out = await render({ door: "image" });
    expect(text(out)).toContain("No server to deploy to");
    expect(text(out)).toContain("offline: the agent does not answer");
  });
});

describe("New project with GitHub connected", () => {
  beforeEach(() => {
    github.connected = true;
  });

  it("offers the repository door, which still opens the repository wizard", async () => {
    expect(await render()).toContain('href="/projects/new?door=repository"');
    const out = await render({ door: "repository" });
    expect(text(out)).toContain("Choose the repository");
    expect(out).toContain("acme/shop");
  });

  it("an address with a repository goes straight to its wizard", async () => {
    const out = await render({ repo: "acme/shop" });
    expect(text(out)).toContain("Choose how it is built");
  });

  it("and the image door is still there", async () => {
    expect(text(await render({ door: "image" }))).toContain("Describe what to run");
  });
});
