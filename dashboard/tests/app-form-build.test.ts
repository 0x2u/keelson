import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/agent-types";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-app-form-build-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {}, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { AppForm, appFromDraft, draftFromApp } = await import("@/components/config/AppForm");
const { BuildCard } = await import("@/components/repository/BuildCard");

const preset = (build: NonNullable<AppConfig["build"]>, extra: Partial<AppConfig> = {}): AppConfig => ({
  name: "site",
  image: "keelson-local/site",
  port: 3000,
  domains: ["site.example.com"],
  health_path: "/",
  build,
  release: { steps: [{ name: "release", container: { command: ["sh", "-c", "npx prisma migrate deploy"] } }] },
  ...extra,
});

const BLOCKS: NonNullable<AppConfig["build"]>[] = [
  { preset: "nextjs", install: "pnpm i", build_command: "pnpm build", start: "node server.js", node: "20", standalone: true, memory: "4g", cpus: 3, timeout: "30m", args: { NEXT_PUBLIC_A: "1" } },
  { preset: "node", context: "api", start: "node dist/main.js", memory: "2g", cpus: 2, timeout: "15m" },
  { preset: "vite", output_dir: "build", spa: false, node: "22", memory: "2g", cpus: 2, timeout: "15m", max_source: "100m", source_hosts: ["github.com"] },
  { preset: "static", build_command: "make site", install: "npm ci", output_dir: "public", node: "20", memory: "2g", cpus: 2, timeout: "15m" },
  { dockerfile: "docker/Dockerfile", context: "app", target: "prod", memory: "2g", cpus: 2, timeout: "15m" },
  { dockerfile: "Dockerfile", network: "host", memory: "2g", cpus: 2, timeout: "15m" },
  { dockerfile: "Dockerfile", network: "keelson", database: true, memory: "2g", cpus: 2, timeout: "15m" },
];

describe("the per-app form and a build: block", () => {
  for (const build of BLOCKS) {
    it(`editing and saving an app built with ${build.preset ?? "a Dockerfile"} keeps its whole block`, () => {
      const app = preset(build);
      const saved = appFromDraft(draftFromApp(app));
      expect(saved.build).toEqual(app.build);
      expect(saved).toEqual(app);
    });
  }

  it("changes the framework's options and keeps the limits and the build arguments", () => {
    const app = preset(BLOCKS[0]!);
    const draft = draftFromApp(app);
    const saved = appFromDraft({ ...draft, buildOptions: { ...draft.buildOptions, install: "", standalone: false, node: "22" } });
    expect(saved.build).toEqual({ preset: "nextjs", build_command: "pnpm build", start: "node server.js", node: "22", memory: "4g", cpus: 3, timeout: "30m", args: { NEXT_PUBLIC_A: "1" } });
  });

  it("turns the build's host network on and off, and writes no network key when it is off", () => {
    const app = preset(BLOCKS[0]!);
    const draft = draftFromApp(app);
    expect(draft.buildHostNetwork).toBe(false);
    expect(appFromDraft({ ...draft, buildHostNetwork: true }).build?.network).toBe("host");
    const hosted = draftFromApp(preset(BLOCKS[5]!));
    expect(hosted.buildHostNetwork).toBe(true);
    expect(appFromDraft({ ...hosted, buildHostNetwork: false }).build).not.toHaveProperty("network");
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: preset(BLOCKS[5]!), existingNames: ["site"], hasProxy: true }));
    expect(html).toContain("Build on the server&#x27;s network");
  });

  it("turns the build's use of the database on and off, and keeps a network the form has no switch for", () => {
    const app = preset(BLOCKS[6]!);
    const draft = draftFromApp(app);
    expect(draft.buildDatabase).toBe(true);
    expect(draft.buildHostNetwork).toBe(false);
    // a user-defined network named in the file is not the host switch: it stays when the switch is left off
    expect(appFromDraft(draft).build).toEqual(app.build);
    expect(appFromDraft({ ...draft, buildDatabase: false }).build).not.toHaveProperty("database");
    expect(appFromDraft({ ...draft, buildDatabase: false }).build?.network).toBe("keelson");
    // the host switch replaces it
    expect(appFromDraft({ ...draft, buildHostNetwork: true }).build?.network).toBe("host");
    expect(appFromDraft({ ...draftFromApp(preset(BLOCKS[0]!)), buildDatabase: true }).build?.database).toBe(true);
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app, existingNames: ["site"], hasProxy: true }));
    expect(html).toContain("The build uses the app&#x27;s database");
  });

  it("shows the Build section with the preset and its options for an app that has a block, and none for one that has not", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: preset(BLOCKS[0]!), existingNames: ["site"], hasProxy: true }));
    expect(html).toContain("Framework");
    expect(html).toContain('value="pnpm i"');
    expect(html).toContain('value="node server.js"');
    expect(html).toContain('value="20"');
    expect(html).toContain('id="');
    expect(html).toContain("Standalone output");
    expect(html).toContain('data-state="checked"'); // standalone is on
    const plain = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: { name: "web", image: "x" }, existingNames: ["web"], hasProxy: true }));
    expect(plain).not.toContain("Framework");
    const created = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", existingNames: [], hasProxy: true }));
    expect(created).not.toContain("How the agent builds this app");
  });

  it("shows the Dockerfile fields for an app built from its own Dockerfile", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: preset(BLOCKS[4]!), existingNames: ["site"], hasProxy: true }));
    expect(html).toContain('value="docker/Dockerfile"');
    expect(html).toContain('value="prod"');
  });

  it("shows the release command written by New project as a release step", () => {
    const html = renderToStaticMarkup(createElement(AppForm, { serverId: "s1", baseHash: "h", app: preset(BLOCKS[1]!), existingNames: ["site"], hasProxy: true }));
    expect(html).toContain('value="release"');
    expect(html).toContain('value="npx prisma migrate deploy"');
  });
});

describe("the Source page's build card", () => {
  const card = (build?: AppConfig["build"]) =>
    renderToStaticMarkup(createElement(BuildCard, { serverId: "s1", app: "site", appConfigured: true, appSlug: "keelson-ab", onPush: true, previews: false, secretSet: true, canDeploy: true, build }));

  it("names the preset and its options", () => {
    const html = card(BLOCKS[0]);
    expect(html).toContain('data-testid="build-summary"');
    expect(html).toContain("Next.js preset");
    expect(html).toContain("Install: pnpm i");
    expect(html).toContain("Standalone output");
  });

  it("names the repository's Dockerfile for the other card, and says nothing without a block", () => {
    expect(card(BLOCKS[4])).toContain("Repository Dockerfile");
    expect(card(undefined)).not.toContain('data-testid="build-summary"');
  });
});
