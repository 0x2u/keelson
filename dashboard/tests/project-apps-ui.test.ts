import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppStatus, ProxyView } from "@/lib/agent-types";
import type { EnvironmentSource } from "@/components/projects/AddEnvironmentButton";
import { planAddEnvironment, planRenameProject, serverChoices, soleServer } from "@/lib/project-lifecycle-core";
import { groupProjects, type Placement } from "@/lib/projects-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { ProjectApps } = await import("@/components/projects/ProjectApps");
const { AddAppButton } = await import("@/components/projects/AddAppButton");
const { AddEnvironmentButton, PlanSummary } = await import("@/components/projects/AddEnvironmentButton");
const { RenamePlanSummary } = await import("@/components/projects/RenameProjectDialog");
const { ProjectActionsMenu } = await import("@/components/projects/ProjectActionsMenu");
const { ProjectDomains } = await import("@/components/projects/ProjectDomains");
const { AppForm } = await import("@/components/config/AppForm");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const render = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

const s1 = { id: "s1", name: "vps-1", canDeploy: true };
const s2 = { id: "s2", name: "vps-2", canDeploy: false };
const state = (running: boolean) => ({ status: running ? "running" : "exited", running, paused: false, restarting: false, oom_killed: false, exit_code: running ? 0 : 1, started_at: "2026-10-01T00:00:00Z" });
const container = (name: string, running: boolean) => ({ id: name, name, image: "ghcr.io/acme/shop:abc", created: "", tty: false, restart_count: 0, ports: [], state: state(running) });
const app = (name: string, over: Partial<AppStatus> = {}): AppStatus => ({ name, image: "ghcr.io/acme/shop", project: "shop", environment: "", digest: "", container: null, last_deployment: null, ...over });
const place = (a: AppStatus, server = s1): Placement => ({ server, app: a, jobs: [] });

const project = groupProjects([
  place(app("shop", { container: container("shop", true), domains: ["shop.example.com"] })),
  place(app("shop-pr-3", { environment: "preview", container: container("shop-pr-3", true) })),
  place(app("shop", { environment: "staging", container: container("shop-staging", false) }), s2),
  place(app("shop-worker")),
])[0];
const proxy = { type: "caddy", routes: [{ kind: "app", app: "shop", domains: ["shop.example.com"], upstream: "127.0.0.1:1", container: "shop", ref: "", updated_at: "", running: true }], unrouted: [] } as unknown as ProxyView;

const choices = serverChoices([{ ...s1, transport: "direct", serves: false }, { ...s2, canDeploy: true, transport: "direct", serves: false }], ["s1"]);
const sources: EnvironmentSource[] = [{ key: "s1/shop", environment: "production", primary: true, server: s1, app: { name: "shop", image: "ghcr.io/acme/shop" }, config: null }];
const add = { servers: choices, environments: ["production", "staging", "preview"], sources, appNames: { s1: ["shop", "shop-pr-3", "shop-worker"], s2: ["shop"] } };
const dbs = [{ server: { id: "s1", name: "vps-1" }, name: "shop", engine: "postgres", container: "keelson-db-shop" }];

describe("ProjectApps", () => {
  const html = render(createElement(ProjectApps, { project, histories: {}, databases: dbs, add }));
  it("lists every placement, with the preview under its parent", () => {
    expect(html.match(/data-testid="app-card"/g)).toHaveLength(4);
    expect(html).toContain("Previews of shop");
    expect(html).toContain("staging");
  });
  it("says the state of a stopped container and a never deployed app", () => {
    expect(html).toContain("Stopped");
    expect(html).toContain("Never deployed");
  });
  it("links to the container logs and to the config forms with the Apps tab as the way back", () => {
    expect(html).toContain("/servers/s1/containers/shop");
    expect(html).toContain("/servers/s1/config/apps/shop?from=%2Fprojects%2Fshop%2Fapps");
    expect(html).not.toContain("%2Fservices");
    expect(html).toContain("keelson-db-shop");
  });
  it("disables editing on a read-only server", () => {
    expect(html).toContain("Read-only server");
  });
  it("has one Add app and one Add environment", () => {
    expect(html.match(/Add app/g)).toHaveLength(1);
    expect(html.match(/Add environment/g)).toHaveLength(1);
  });
  it("offers the first action when empty", () => {
    const empty = render(createElement(ProjectApps, { project: { name: "x", environments: [] }, histories: {}, databases: [], add }));
    expect(empty).toContain('data-slot="empty-state"');
  });
});

describe("Add app", () => {
  it("opens the dialog when there is a server to choose from, and links straight to the form when only one can take it", () => {
    const asks = render(createElement(AddAppButton, { target: { kind: "server", project: "shop", choices } }));
    expect(asks).toContain("<button");
    const one = serverChoices([{ ...s1, transport: "direct", serves: false }, { ...s2, canDeploy: false, transport: "direct", serves: false }], ["s1"]);
    expect(soleServer(one)?.id).toBe("s1");
    const direct = render(createElement(AddAppButton, { target: { kind: "server", project: "shop", choices: one } }));
    expect(direct).toContain('href="/servers/s1/config/apps/new?from=%2Fprojects%2Fshop%2Fapps"');
  });
  it("is disabled, with a reason, when no server can take an app", () => {
    const none = serverChoices([{ ...s2, transport: "direct", serves: false }], []);
    const html = render(createElement(AddAppButton, { target: { kind: "server", project: "shop", choices: none } }));
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("href=");
  });
  it("from a server asks for the project, and goes to New project when there is none", () => {
    const asks = render(createElement(AddAppButton, { target: { kind: "project", serverId: "s1", serverName: "vps-1", canDeploy: true, projects: ["shop"] } }));
    expect(asks).toContain("<button");
    const first = render(createElement(AddAppButton, { target: { kind: "project", serverId: "s1", serverName: "vps-1", canDeploy: true, projects: [] } }));
    expect(first).toContain('href="/projects/new?server=s1"');
    const readOnly = render(createElement(AddAppButton, { target: { kind: "project", serverId: "s2", serverName: "vps-2", canDeploy: false, projects: ["shop"] } }));
    expect(readOnly).toContain('data-gate="read-only"');
  });
});

describe("Add environment", () => {
  it("is a button, disabled when no server can take an app", () => {
    const html = render(createElement(AddEnvironmentButton, { project: "shop", environments: ["production"], sources, servers: serverChoices([{ ...s2, transport: "direct", serves: false }], []), appNames: {} }));
    expect(html).toContain('disabled=""');
    const enabled = render(createElement(AddEnvironmentButton, { project: "shop", environments: ["production"], sources, servers: choices, appNames: {} }));
    expect(enabled).not.toContain('disabled=""');
  });
  it("shows what is written and says that variables and domains are not copied", () => {
    const plan = planAddEnvironment({ project: "shop", environment: "staging", server: s1, from: { server: s1, app: { name: "shop", image: "ghcr.io/acme/shop" }, config: { name: "shop", image: "ghcr.io/acme/shop", port: 3000, volumes: ["data:/data"], env: { A: "1" }, domains: ["shop.example.com"] } }, existingEnvironments: ["production"], existingAppNames: ["shop"] });
    if (!plan.ok) throw new Error(plan.reason);
    const html = render(createElement(PlanSummary, { project: "shop", environment: "staging", serverName: "vps-1", plan }));
    expect(html).toContain("shop-staging");
    expect(html).toContain('data-testid="environment-plan"');
    expect(html).not.toContain("shop.example.com");
  });
});

describe("the project's actions", () => {
  it("rename plan lists each server with its counts", () => {
    const plan = planRenameProject({
      from: "shop",
      to: "store",
      existingProjects: ["shop"],
      facts: [{ server: s1, entities: [{ kind: "app", name: "shop", label: "", inAppsFile: true }, { kind: "job", name: "nightly", label: "shop", inAppsFile: true }] }, { server: { ...s2, canDeploy: true }, entities: [{ kind: "app", name: "shop-eu", label: "shop", inAppsFile: true }] }],
    });
    if (!plan.ok) throw new Error(plan.reason);
    const html = render(createElement(RenamePlanSummary, { plan }));
    expect(html).toContain('data-testid="rename-plan"');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("vps-1");
    expect(html).toContain("vps-2");
  });
  it("the menu is a trigger, and its content (add app, add environment, rename, how a project goes) opens from it", () => {
    const html = render(createElement(ProjectActionsMenu, { project: "shop" }));
    expect(html).toContain('aria-haspopup="menu"');
  });
});

describe("ProjectDomains", () => {
  const html = render(createElement(ProjectDomains, { project, proxies: { s1: { view: proxy }, s2: { view: null, error: "agent down" } }, cloudflare: false }));
  it("checks the names of the placement that has some and links the proxy tab", () => {
    expect(html).toContain("shop.example.com");
    expect(html).toContain("/servers/s1/proxy");
    expect(html).toContain('data-testid="route-table"');
  });
  it("says there is no domain, and names the server that did not answer", () => {
    expect(html).toContain("No domain");
    expect(html).toContain("agent down");
  });
});

describe("AppForm from a project", () => {
  const form = (over: object) => render(createElement(AppForm, { serverId: "s1", baseHash: "h", existingNames: [], hasProxy: true, ...over }));
  it("creates with the project label, read-only", () => {
    const html = form({ fixedProject: "shop" });
    const input = html.match(/<input[^>]*value="shop"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('readOnly=""');
  });
  it("leaves the project of an existing app alone", () => {
    const html = form({ fixedProject: "shop", app: { name: "web", image: "x", project: "other" } });
    expect(html).toContain('value="other"');
  });
});
