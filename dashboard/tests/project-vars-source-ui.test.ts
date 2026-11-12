import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppStatus, ConfigModel, EnvVars } from "@/lib/agent-types";
import type { AppEnvironment } from "@/lib/app-environment";
import type { AppSource, SourceContext } from "@/lib/app-source";
import type { AppRepo } from "@/lib/integrations";
import { compareEnvironments, pickVariablesTarget } from "@/lib/project-variables-core";
import { pickSourceApp } from "@/lib/project-source-core";
import { groupProjects, type Placement, type ServerRef } from "@/lib/projects-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-project-vars-source-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("@/lib/step-up", () => ({ stepUpError: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ notFound: () => {}, redirect: () => {}, usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ProjectVariables } = await import("@/components/projects/ProjectVariables");
const { VariableCompare } = await import("@/components/projects/VariableCompare");
const { ProjectSource } = await import("@/components/projects/ProjectSource");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const html = (element: unknown) => renderToStaticMarkup(createElement(TooltipProvider, null, element as ReactElement));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const alpha: ServerRef = { id: "s1", name: "alpha", canDeploy: true };
const beta: ServerRef = { id: "s2", name: "beta", canDeploy: false };
const app = (name: string, environment = ""): AppStatus => ({ name, image: "x", project: "shop", environment, digest: "", container: null, last_deployment: null }) as AppStatus;
const place = (a: AppStatus, server = alpha): Placement => ({ server, app: a, jobs: [] });
const project = groupProjects([place(app("shop")), place(app("shop-api")), place(app("shop-staging", "staging"), beta)])[0];
const target = (query: { env?: string; app?: string } = {}) => pickVariablesTarget(project, query)!;

const ready = (over: Partial<Extract<AppEnvironment, { kind: "ready" }>> = {}): AppEnvironment => ({
  kind: "ready",
  app: app("shop"),
  appConfig: { name: "shop", env_file: "/srv/shop.env", env: { LOG_LEVEL: "debug-secret-value" } } as never,
  scope: "app",
  hasPreviews: false,
  vars: { scope: "app", vars: [{ key: "DATABASE_URL", updated_at: "2026-10-21T10:00:00Z", build: false, shadows: null }] } as EnvVars,
  servingImage: "registry.example.com/shop:v1",
  rules: { portKeys: [] },
  pending: null,
  changed: "2026-10-21T10:00:00Z",
  ...over,
});

describe("the Variables tab", () => {
  it("shows the real editor for the chosen app, the file sources by name, and never a value", () => {
    const out = html(createElement(ProjectVariables, { project: "shop", target: target(), env: ready(), machine: false }));
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("Add variable");
    expect(out).toContain("Import .env");
    expect(out).toContain("Delete DATABASE_URL");
    expect(out).toContain("env_file /srv/shop.env");
    expect(out).toContain("LOG_LEVEL");
    expect(out).not.toContain("debug-secret-value");
  });

  it("offers the environments and, when an environment has several apps, the apps", () => {
    const out = html(createElement(ProjectVariables, { project: "shop", target: target(), env: ready(), machine: false }));
    expect(out).toContain('aria-label="Environment"');
    expect(out).toContain('href="/projects/shop/variables?env=staging"');
    expect(out).toContain('aria-label="App"');
    expect(out).toContain("env=production&amp;app=s1%2Fshop-api");
    const staging = html(createElement(ProjectVariables, { project: "shop", target: target({ env: "staging" }), env: ready({ app: app("shop-staging", "staging") }), machine: false }));
    expect(staging).not.toContain('aria-label="App"');
  });

  it("has no switcher for a project with one environment and one app", () => {
    const solo = groupProjects([place(app("solo"))].map((p) => ({ ...p, app: { ...p.app, project: "solo" } })))[0];
    const out = html(createElement(ProjectVariables, { project: "solo", target: pickVariablesTarget(solo, {})!, env: ready(), machine: false }));
    expect(out).not.toContain('aria-label="Environment"');
    expect(out).not.toContain('aria-label="App"');
  });

  it("says a server is read-only and disables the actions", () => {
    const out = html(createElement(ProjectVariables, { project: "shop", target: target({ env: "staging" }), env: ready({ app: app("shop-staging", "staging") }), machine: false }));
    expect(out).toContain("This server is read-only here");
    expect(out).toMatch(/<button[^>]* disabled=""[^>]*>[^<]*(<svg[^>]*>.*?<\/svg>)?Add variable/);
  });

  it("tells a change that is not deployed yet, with a Deploy link", () => {
    const out = html(createElement(ProjectVariables, { project: "shop", target: target(), env: ready({ pending: { changedAt: "2026-10-21T10:00:00Z" } }), machine: false }));
    expect(out).toContain("Changed since the running version");
    expect(out).toContain('href="/servers/s1/apps/shop?deploy=');
  });

  it("shows a Preview scope only for an app with a previews template", () => {
    expect(html(createElement(ProjectVariables, { project: "shop", target: target(), env: ready(), machine: false }))).not.toContain('aria-label="Scope"');
    const out = html(createElement(ProjectVariables, { project: "shop", target: target(), env: ready({ hasPreviews: true }), machine: false }));
    expect(out).toContain('aria-label="Scope"');
    expect(out).toContain("scope=preview");
  });

  it("says why nothing is listed: an agent that cannot manage variables, a server that failed", () => {
    const old = html(createElement(ProjectVariables, { project: "shop", target: target(), env: { kind: "too-old" }, machine: false }));
    expect(old).toContain("This agent is too old to manage variables");
    expect(old).toContain("/servers/s1/update");
    expect(old).not.toContain("Add variable");
    const machine = html(createElement(ProjectVariables, { project: "shop", target: target(), env: { kind: "too-old" }, machine: true }));
    expect(machine).not.toContain("/servers/s1/update");
    expect(html(createElement(ProjectVariables, { project: "shop", target: target(), env: { kind: "apps-error", error: "connection refused" }, machine: false }))).toContain("connection refused");
    expect(html(createElement(ProjectVariables, { project: "shop", target: target(), env: { kind: "vars-error", error: "boom" }, machine: false }))).toContain("Could not load the variables");
  });
});

describe("the environment comparison", () => {
  const model = (env: Record<string, string>, name: string) => ({ apps: [{ name, env }] }) as unknown as ConfigModel;
  const facts = [
    { server: alpha, apps: [], jobs: [], databases: [], config: model({ A: "1", ONLY_PROD: "x" }, "shop") },
    { server: beta, apps: [], jobs: [], databases: [], config: model({ A: "2" }, "shop-staging") },
  ];
  it("is a collapsed section until a pair is asked for, and lists the differences", () => {
    const c = compareEnvironments(project, facts)!;
    const closed = html(createElement(VariableCompare, { project: "shop", comparison: c, open: false }));
    expect(closed).toContain("Compare environments");
    expect(closed).not.toContain(" open");
    expect(closed).toContain("ONLY_PROD");
    expect(closed).toContain("Different");
    expect(closed).toContain("Only here");
    expect(html(createElement(VariableCompare, { project: "shop", comparison: c, open: true }))).toContain("<details class=\"group\" open");
  });
  it("names a side that could not be read", () => {
    const c = compareEnvironments(project, [facts[0]])!;
    expect(html(createElement(VariableCompare, { project: "shop", comparison: c, open: true }))).toContain("beta did not answer");
  });
});

const link: AppRepo = { repo: "acme/shop", branch: "main", autoDeployWorkflow: "CI", previewsWorkflow: null, buildOnPush: false, buildPreviews: false, buildOn: null };
const context = (over: Partial<SourceContext> = {}): SourceContext => ({
  serverId: "s1",
  serverName: "alpha",
  app: "shop",
  canDeploy: true,
  githubApp: null,
  secretSet: true,
  build: undefined,
  where: {
    ownName: "alpha",
    ownStats: { online: true },
    choices: [],
    notSent: { stored: [], hidden: [] },
    buildVars: {},
    buildWarning: null,
  },
  ...over,
});
const linked = (over: Partial<Extract<AppSource, { kind: "linked" }>> = {}): AppSource => ({
  kind: "linked",
  context: context(),
  link,
  serving: `ghcr.io/acme/shop:${SHA}`,
  servingSha: SHA,
  commits: { data: [{ sha: HEAD, message: "Fix the cart", author: "ana", date: "2026-10-21T10:00:00Z", url: `https://github.com/acme/shop/commit/${HEAD}` }] },
  runs: { data: [{ id: 1, name: "CI", number: 12, state: "success", branch: "main", sha: HEAD, event: "push", startedAt: "2026-10-21T10:00:00Z", url: "https://github.com/acme/shop/actions/runs/1" }] },
  behind: { data: { aheadBy: 2 } as never },
  repos: [],
  previews: { data: [] },
  deployments: [],
  deploying: false,
  ...over,
});
const choices = () => pickSourceApp(project, undefined)!;
const renderSource = (source: AppSource, app?: string) => {
  const picked = pickSourceApp(project, app)!;
  return html(createElement(ProjectSource, { project: "shop", choices: picked.choices, chosen: picked.chosen, source }));
};

describe("the Source tab", () => {
  it("shows the repository, what serves against the branch head, CI, and the cards of the app's Source page", () => {
    const out = renderSource(linked());
    expect(out).toContain("acme/shop");
    expect(out).toContain("0123456");
    expect(out).toContain("2 commits behind main.");
    expect(out).toContain("Latest CI run on main");
    expect(out).toContain("Deploy from source");
    expect(out).not.toContain("Build &amp; deploy");
    expect(out).toContain("Fix the cart");
    expect(out).toContain("Automatic deploys");
    expect(out).toContain("Previews");
    // The whole history is on the tab itself: no link out to the app's own Source page (which now leads back here).
    expect(out).not.toContain("/servers/s1/apps/shop/source");
    expect(out).toContain('data-slot="table"');
  });

  it("lets the user switch app when the project has several", () => {
    expect(choices().choices.length).toBe(3);
    const out = renderSource(linked());
    expect(out).toContain('aria-label="App"');
    expect(out).toContain("source?app=s2%2Fshop-staging");
  });

  it("blocks deploying a commit on a read-only server, saying why", () => {
    const out = renderSource(linked({ context: context({ canDeploy: false }) }), "s2/shop-staging");
    const head = out.split('data-testid="head-commit"')[1].split("Automatic deploys")[0];
    expect(head).toMatch(/<button[^>]* disabled=""/);
    expect(out).toMatch(/<button[^>]* disabled=""[^>]*>Unlink/);
    const open = renderSource(linked(), "s1/shop").split('data-testid="head-commit"')[1].split("Automatic deploys")[0];
    expect(open).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("offers to link a repository when there is none", () => {
    const out = renderSource({ kind: "unlinked", context: context(), repos: [] });
    expect(out).toContain('data-slot="empty-state"');
  });

  it("sends to the integrations when GitHub is not connected, keeping an earlier link visible", () => {
    const out = renderSource({ kind: "no-github", context: context(), kept: link, keptPreviews: null });
    expect(out).toContain("Connect GitHub first");
    expect(out).toContain("/settings/integrations");
    expect(out).toContain("acme/shop");
  });

  it("names a commit list that could not be read", () => {
    const out = renderSource(linked({ commits: { error: "rate limited" } }));
    expect(out).toContain("Could not load the commits");
    expect(out).toContain("rate limited");
  });
});
