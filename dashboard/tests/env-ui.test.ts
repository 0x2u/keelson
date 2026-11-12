import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/agent-types";
import { FakeEnvAgent } from "./fake-env-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-env-ui-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const redirects = vi.hoisted((): string[] => []);

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    redirects.push(to);
  },
  usePathname: () => "/",
  useRouter: () => ({ refresh() {}, push() {} }),
}));
// The app page's other cards are not what is looked at here.
vi.mock("@/components/config/ConfigChangedBadge", () => ({ ConfigChangedBadge: () => null }));
vi.mock("@/components/domains/DomainsCard", () => ({ DomainsCard: () => null }));
vi.mock("@/components/ContainerControls", () => ({ ContainerControls: () => null }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const servers = await import("@/lib/servers");
const { default: EnvironmentPage } = await import("@/app/(app)/servers/[id]/apps/[app]/environment/page");
const { default: AppPage } = await import("@/app/(app)/servers/[id]/apps/[app]/page");
const { saveEnvAction } = await import("@/app/env-actions");
const { ImportReviewTable } = await import("@/components/environment/ImportDialog");
const { BuildField } = await import("@/components/environment/BuildField");
const { EnvChangedBadge } = await import("@/components/environment/EnvChangedBadge");
const { parseDotenv } = await import("@/lib/dotenv-core");
const { reviewImport } = await import("@/lib/env-core");

const agent = new FakeEnvAgent();
let id = "";
let readOnlyId = "";
const VALUE = "postgres://app:hunter2-super-secret@db.internal/app";

beforeAll(async () => {
  await agent.start();
  id = servers.createServer({ name: "staging", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
  readOnlyId = servers.createServer({ name: "viewer", url: agent.url, token: "t".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  agent.scopes.app.clear();
  agent.scopes.preview.clear();
  agent.requests.length = 0;
  agent.opts = {};
  redirects.length = 0;
});

const deployment = (over: Partial<Deployment> = {}): Deployment => ({ id: "d1", app: "shop", ref: "registry.example.com/shop:v1.2", status: "succeeded", trigger: "api", started_at: "2026-10-21T10:00:00Z", ...over });
const html = (element: unknown) => renderToStaticMarkup(createElement(TooltipProvider, null, element as ReactElement));
const envPage = async (query: Record<string, string> = {}, serverId = id) =>
  html(await EnvironmentPage({ params: Promise.resolve({ id: serverId, app: "shop" }), searchParams: Promise.resolve(query) }));

describe("the environment page", () => {
  it("lists the names with Set, a build badge and the override badge, and never a value", async () => {
    agent.opts.shadows = { DATABASE_URL: "env_file", LOG_LEVEL: "env" };
    agent.seed("app", "DATABASE_URL", VALUE);
    agent.seed("app", "LOG_LEVEL", "debug-level-value");
    agent.seed("app", "NEXT_PUBLIC_API", "https://api.example.com/very-public", { build: true });
    const out = await envPage();
    expect(out).toContain("Variables");
    for (const key of ["DATABASE_URL", "LOG_LEVEL", "NEXT_PUBLIC_API"]) expect(out).toContain(key);
    expect(out).toContain("Set");
    expect(out).toContain("Overrides env_file");
    expect(out).toContain("Overrides env<");
    expect(out.match(/>build</g)).toHaveLength(1);
    expect(out).toContain("changed");
    for (const value of [VALUE, "hunter2", "debug-level-value", "very-public"]) expect(out).not.toContain(value);
  });

  it("sends the variables of an app of a project to the project's Variables tab, keeping the preview scope", async () => {
    await envPage();
    await envPage({ scope: "preview" });
    expect(redirects).toEqual([`/projects/shop/variables?app=${id}%2Fshop`, `/projects/shop/variables?app=${id}%2Fshop&scope=preview`]);
  });

  it("shows no value after a save either: a value saved through the action is nowhere in the page", async () => {
    expect(await saveEnvAction(id, "shop", "app", [{ key: "STRIPE_SECRET", value: VALUE, build: false }])).toEqual({ ok: true, changed: 1, removed: 0 });
    expect(agent.scopes.app.get("STRIPE_SECRET")?.value).toBe(VALUE);
    const out = await envPage();
    expect(out).toContain("STRIPE_SECRET");
    expect(out).not.toContain(VALUE);
    expect(out).not.toContain("hunter2");
    // The page reads names from the agent: it never asked for a value, and the only call with one was the signed PUT.
    expect(agent.requests.filter((r) => r.body.includes("hunter2")).map((r) => r.line)).toEqual(["PUT /v1/apps/shop/env"]);
  });

  it("offers adding, importing and, once there is a variable, removing all; each variable can be replaced or deleted", async () => {
    const empty = await envPage();
    expect(empty).toContain("No variable yet");
    expect(empty).toContain("Add variable");
    expect(empty).toContain("Import .env");
    expect(empty).not.toContain("Remove all");
    agent.seed("app", "A", "a-value-1");
    const out = await envPage();
    expect(out).toContain("Remove all");
    expect(out).toContain("value of A");
    expect(out).toContain("Delete A");
  });

  it("tells an agent too old to manage variables, with a way to update it", async () => {
    agent.opts.old = true;
    const out = await envPage();
    expect(out).toContain("This agent is too old to manage variables");
    expect(out).toContain(`/servers/${id}/update`);
    expect(out).not.toContain("Add variable");
  });

  it("has a Preview tab only for an app with a previews template, and reads that scope there", async () => {
    agent.seed("app", "PROD_ONLY", "p-value-1");
    agent.seed("preview", "PREVIEW_ONLY", "q-value-1");
    const without = await envPage({ scope: "preview" });
    expect(without).not.toContain(`aria-label="Scope"`);
    expect(without).toContain("PROD_ONLY");
    expect(without).not.toContain("PREVIEW_ONLY");

    agent.opts.previewApps = ["shop"];
    const withTemplate = await envPage({ scope: "preview" });
    expect(withTemplate).toContain(`aria-label="Scope"`);
    expect(withTemplate).toContain("production");
    expect(withTemplate).toContain("Previews");
    expect(withTemplate).toContain("PREVIEW_ONLY");
    expect(withTemplate).not.toContain("PROD_ONLY");
    expect(withTemplate).toContain("never inherits");
    expect(agent.requests.some((r) => r.line === "GET /v1/apps/shop/env?scope=preview")).toBe(true);
    expect(await envPage()).toContain("PROD_ONLY");
  });

  it("is read-only for a server with no deploy secret", async () => {
    agent.seed("app", "A", "a-value-1");
    const out = await envPage({}, readOnlyId);
    expect(out).toContain("This server is read-only here");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>(<svg[^>]*>.*?<\/svg>)?Add variable/);
  });

  it("prompts to redeploy when the variables changed after the running version was deployed, with the prefilled Deploy", async () => {
    agent.seed("app", "A", "a-value-1", { updated_at: "2026-10-22T09:00:00Z" });
    agent.opts.deployments = [deployment({ started_at: "2026-10-21T10:00:00Z" })];
    const out = await envPage();
    expect(out).toContain("Changed since the running version");
    expect(out).toContain(`href="/servers/${id}/apps/shop?deploy=v1.2"`);
  });

  it("does not prompt once a deployment started after the change, nor in the preview scope", async () => {
    agent.seed("app", "A", "a-value-1", { updated_at: "2026-10-22T09:00:00Z" });
    agent.opts.deployments = [deployment({ started_at: "2026-10-22T10:00:00Z" })];
    expect(await envPage()).not.toContain("Changed since the running version");
    agent.opts.deployments = [deployment({ started_at: "2026-10-21T10:00:00Z" })];
    agent.opts.previewApps = ["shop"];
    expect(await envPage({ scope: "preview" })).not.toContain("Changed since the running version");
  });

});

describe("the app page", () => {
  const appPage = async () => html(await AppPage({ params: Promise.resolve({ id, app: "shop" }), searchParams: Promise.resolve({}) }));

  it("links to the variables, and carries a persistent badge while the running version is behind", async () => {
    agent.seed("app", "A", "a-value-1", { updated_at: "2026-10-22T09:00:00Z" });
    agent.opts.deployments = [deployment({ started_at: "2026-10-21T10:00:00Z" })];
    const out = await appPage();
    // An app of a project links to the project's tabs, with the project's breadcrumb (Projects > shop > Apps > shop).
    expect(out).toContain(`href="/projects/shop/variables?app=${id}%2Fshop"`);
    expect(out).toContain(`href="/projects/shop/source?app=${id}%2Fshop"`);
    expect(out).toContain('href="/projects/shop/apps"');
    expect(out).toContain("Variables changed since the running version");
  });

  it("has no badge when the running version has the variables", async () => {
    agent.seed("app", "A", "a-value-1", { updated_at: "2026-10-22T09:00:00Z" });
    agent.opts.deployments = [deployment({ started_at: "2026-10-22T10:00:00Z" })];
    const out = await appPage();
    expect(out).toContain(`href="/projects/shop/variables?app=${id}%2Fshop"`);
    expect(out).not.toContain("Variables changed since the running version");
  });

  it("renders the badge from plain props", () => {
    const out = html(createElement(EnvChangedBadge, { serverId: "s1", app: "shop" }));
    expect(out).toContain('href="/servers/s1/apps/shop/environment"');
    expect(out).toContain("Variables changed since the running version");
  });
});

describe("the form's build-time warning", () => {
  it("is always there, and says the value is baked into the image and visible in its history", () => {
    const out = html(createElement(BuildField, { name: "NEXT_PUBLIC_X", checked: false, onChange: () => {} }));
    expect(out).toContain("Available at build time");
    expect(out).toContain("baked into the image");
    expect(out).toContain("visible in its history");
    expect(out).toContain("Never use it for a secret");
    expect(out).not.toContain("looks like a secret");
  });

  it("adds a stronger one when a ticked name looks like a secret", () => {
    expect(html(createElement(BuildField, { name: "STRIPE_SECRET_KEY", checked: true, onChange: () => {} }))).toContain("This name looks like a secret");
    expect(html(createElement(BuildField, { name: "STRIPE_SECRET_KEY", checked: false, onChange: () => {} }))).not.toContain("This name looks like a secret");
  });
});

describe("the import review", () => {
  const text = [
    "# production",
    "DATABASE_URL=postgres://app:hunter2-secret@db/app",
    "export NEXT_PUBLIC_API=https://api.example.com",
    'MULTI="line one',
    'line two-secret"',
    "EXISTING=replaced-secret",
    "PATH=/bin",
    "1BAD=x",
    "just text",
    "DATABASE_URL=postgres://app:second-secret@db/app",
    "STRIPE_SECRET=sk_live_abc",
  ].join("\n");
  const stored = [{ key: "EXISTING", updated_at: "2026-10-20T10:00:00Z", build: false, shadows: null }];
  const review = reviewImport(parseDotenv(text), stored);
  const out = html(
    createElement(ImportReviewTable, { review, isBuild: (key: string, suggested: boolean) => (key === "STRIPE_SECRET" ? true : suggested), onBuild: () => {} }),
  );

  it("lists the names with what each would do, and the lines that could not be read", () => {
    for (const key of ["DATABASE_URL", "NEXT_PUBLIC_API", "MULTI", "EXISTING", "PATH"]) expect(out).toContain(key);
    expect(out).toContain("New");
    expect(out).toContain("Replaces<");
    expect(out).toContain("Refused");
    expect(out).toContain("cannot be overridden");
    expect(out).toContain("could not be read");
    expect(out).toContain("Line 8");
    expect(out).toContain("Line 9");
    expect(out).toContain("appear more than once");
    expect(out).toContain("lines 2, 10");
  });

  it("masks every value, and never renders one", () => {
    expect(out.match(/••••••••/g)).toHaveLength(review.rows.length);
    for (const secret of ["hunter2", "second-secret", "line one", "two-secret", "replaced-secret", "api.example.com", "sk_live_abc"]) expect(out).not.toContain(secret);
  });

  it("warns about build time for what is ticked (and ticks the browser-exposed names to start with)", () => {
    expect(out).toContain("Build-time values are baked in");
    expect(out).toContain("baked into the image");
    expect(out).toContain("looks secret");
  });
});
