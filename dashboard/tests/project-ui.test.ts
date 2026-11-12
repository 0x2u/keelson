import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppStatus, Deployment } from "@/lib/agent-types";
import { commitKey } from "@/lib/github-core";
import { placementsOf, type HomeServer } from "@/lib/home-core";
import { groupProjects, type Placement } from "@/lib/projects-core";
import { buildsOn, projectView, type AppSource, type BuildsInfo, type DeploymentEntry, type ProjectContext } from "@/lib/project-view-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh() {}, push() {} }) }));

const { BuildsCard } = await import("@/components/projects/BuildsCard");
const { DeploymentFeed } = await import("@/components/projects/DeploymentFeed");
const { EnvironmentList } = await import("@/components/projects/EnvironmentList");
const { ProductionHero } = await import("@/components/projects/ProductionHero");
const { ProjectGrid } = await import("@/components/projects/ProjectCard");
const { HomeView } = await import("@/components/home/HomeView");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const server = { id: "s1", name: "vps-1", canDeploy: true };
const dep = (over: Partial<Deployment> = {}): Deployment => ({ id: "d1", app: "shop", ref: `ghcr.io/acme/shop:${SHA}`, status: "succeeded", trigger: "build", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR - 52_000), ...over });
function app(over: Partial<AppStatus> = {}): AppStatus {
  return {
    name: "shop",
    image: "ghcr.io/acme/shop",
    project: "shop",
    environment: "",
    digest: "",
    container: { id: "c", name: "shop", image: `ghcr.io/acme/shop:${SHA}`, created: "", tty: false, restart_count: 0, ports: [], state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 } },
    last_deployment: dep(),
    domains: ["www.shop.example.com", "shop.example.com"],
    ...over,
  };
}
const place = (a: AppStatus, s = server): Placement => ({ server: s, app: a, jobs: [] });
const source: AppSource = { repo: "acme/shop", branch: "main", builtOn: "builder-1", started: { [SHA]: "push" } };
const context = (over: Partial<ProjectContext> = {}): ProjectContext => ({
  sources: { "s1/shop": source, "s1/shop-test": source },
  commits: { [commitKey("acme/shop", SHA)]: { message: "Fix the cart total", author: "ana", date: ago(3 * HOUR) } },
  deployments: {},
  ...over,
});
const views = (placements: Placement[], ctx = context()) => groupProjects(placements).map((p) => projectView(p, ctx));
const count = (html: string, needle: string) => html.split(needle).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** The markup of the card of one project. */
const cardOf = (html: string, name: string) => html.split('data-testid="project-card"').find((c) => c.includes(`>${name}</a>`)) ?? "";

describe("the project cards", () => {
  const fleet = [
    place(app()),
    place(app({ name: "shop-test", environment: "test", domains: ["test.shop.example.com"] })),
    place(app({ name: "blog", project: "blog", container: null, last_deployment: null, domains: undefined })),
  ];
  const html = renderToStaticMarkup(createElement(ProjectGrid, { projects: views(fleet) }));

  it("shows one card per project, however many apps it has", () => {
    expect(count(html, 'data-testid="project-card"')).toBe(2);
    expect(count(html, 'href="/projects/shop"')).toBe(1);
  });

  it("opens the project from the card, the live site from the address and an environment from its chip", () => {
    expect(html).toContain('href="/projects/shop"');
    expect(html).toMatch(/<a href="https:\/\/www\.shop\.example\.com" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('href="/servers/s1/apps/shop-test"');
    expect(html).toContain('href="/servers/s1/apps/shop"');
  });

  it("says what runs: the state, the repository, the commit message, the branch, the short hash and how it was deployed", () => {
    const shop = text(cardOf(html, "shop"));
    expect(shop).toContain("Running");
    expect(shop).toContain("acme/shop");
    expect(shop).toContain("Fix the cart total");
    expect(shop).toContain("main");
    expect(shop).toContain("0123456");
    expect(shop).toContain("Push");
  });

  it("names the environments with their state, so colour is never the only carrier", () => {
    expect(html).toMatch(/aria-label="Environments"[\s\S]*Production<span class="sr-only"> Running<\/span>[\s\S]*Test<\/span>|test<span class="sr-only"> Running/);
  });

  it("says plainly when nothing was deployed, and shows no address it does not know", () => {
    expect(text(cardOf(html, "blog"))).toContain("Not deployed");
    expect(text(cardOf(html, "blog"))).toContain("Nothing deployed yet.");
    expect(cardOf(html, "blog")).not.toContain("opens the site");
    expect(cardOf(html, "shop")).toContain("opens the site");
  });

  it("warns that the last deployment failed and names what still serves", () => {
    const failed = dep({ id: "d2", status: "failed", ref: `ghcr.io/acme/shop:${SHA2}`, started_at: ago(HOUR) });
    const out = renderToStaticMarkup(createElement(ProjectGrid, { projects: views([place(app({ last_deployment: failed }))]) }));
    expect(text(out)).toMatch(/The last deployment \(\s*fedcba9\s*\) failed\./);
    expect(text(out)).toMatch(/Still serving\s+0123456/);
    // The headline is what serves, not the failed version.
    expect(out).toMatch(/<p class="[^"]*font-medium[^"]*"[^>]*>[^<]*Fix the cart total/);
    expect(out).not.toMatch(/<p class="[^"]*font-medium[^"]*"[^>]*>[^<]*fedcba9/);
  });

  it("does not say a stopped container serves", () => {
    const stopped = app({ last_deployment: dep({ status: "failed" }) });
    stopped.container!.state = { ...stopped.container!.state, running: false, status: "exited" };
    const out = text(renderToStaticMarkup(createElement(ProjectGrid, { projects: views([place(stopped)]) })));
    expect(out).toContain("Down");
    expect(out).toContain("Stopped");
    expect(out).toContain("Nothing is running.");
    expect(out).not.toContain("Still serving");
  });

  it("uses no word of the old placement model", () => {
    expect(html.toLowerCase()).not.toContain("placement");
  });
});

describe("the home page", () => {
  const apps = [app(), app({ name: "shop-test", environment: "test" })];
  const servers: HomeServer[] = [{ server: { id: "s1", name: "vps-1" }, reachable: true, canDeploy: true, apps, jobs: [], deployments: [] }];
  const render = (projects = views(placementsOf(servers))) =>
    renderToStaticMarkup(createElement(HomeView, { servers: servers.map((s) => ({ ...s, lastSeen: NOW, url: "http://x" })), projects, now: NOW, generatedAt: NOW, needsSecondFactor: false }));

  it("lists the projects as cards, one for a project with a production and a test", () => {
    const html = render();
    const projects = html.slice(html.indexOf('data-testid="projects"'), html.indexOf('aria-labelledby="recent"'));
    expect(count(projects, 'data-testid="project-card"')).toBe(1);
    expect(projects).toContain("Fix the cart total");
    expect(projects).not.toContain("shop-build");
  });

  it("keeps its other sections", () => {
    const html = render();
    for (const id of ["projects", "recent", "servers"]) expect(html).toContain(`aria-labelledby="${id}"`);
  });
});

describe("the production hero", () => {
  const hero = (apps: AppStatus, ctx = context()) => {
    const [view] = views([place(apps)], ctx);
    return renderToStaticMarkup(createElement(ProductionHero, { env: view.primary }));
  };

  it("gives the address first and the version that serves with its commit, branch and hash", () => {
    const html = hero(app());
    expect(html).toContain('href="https://www.shop.example.com"');
    expect(text(html)).toContain("also shop.example.com");
    expect(text(html)).toContain("Serving now");
    expect(text(html)).toContain("Fix the cart total");
    expect(text(html)).toContain("main");
    expect(text(html)).toContain("0123456");
  });

  it("says how and where it was deployed: when, how long it took, who started it, the machine that built it and the server", () => {
    const html = text(hero(app({ last_deployment: dep({ trigger: "transfer" }) })));
    expect(html).toContain("took 52 s");
    expect(html).toContain("Push");
    expect(html).toContain("built on builder-1");
    expect(html).toContain("vps-1");
  });

  it("warns when the last deployment failed while the previous version still serves, with the error and a way to the log", () => {
    const failed = dep({ id: "d2", status: "failed", ref: `ghcr.io/acme/shop:${SHA2}`, started_at: ago(HOUR), error: "health check failed" });
    const html = hero(app({ last_deployment: failed }));
    expect(text(html)).toContain("Deploy failed");
    expect(text(html)).toContain("health check failed");
    expect(text(html)).toContain("The version below is still serving.");
    expect(html).toContain('href="/servers/s1/deployments/d2"');
    expect(text(html)).toContain("Serving now");
  });

  it("names the phase a deploy failed in, draws its pipeline and says what still serves from the agent's word", () => {
    const phases: Deployment["phases"] = [
      { name: "release", status: "done", started_at: ago(HOUR), finished_at: ago(HOUR - 4000) },
      { name: "switch", status: "failed", started_at: ago(HOUR - 4000), finished_at: ago(HOUR - 9000) },
    ];
    const failed = dep({ id: "d2", status: "rolled_back", trigger: "api", ref: `ghcr.io/acme/shop:${SHA2}`, started_at: ago(HOUR), error: "unhealthy", phases, serving_ref: `ghcr.io/acme/shop:${SHA}` });
    const html = hero(app({ last_deployment: failed }));
    expect(text(html)).toContain("Deploy failed in Switch and was rolled back");
    expect(text(html)).toContain("The previous version (0123456789ab) is serving again.");
    expect(text(html)).not.toContain("The version below is still serving.");
    expect(html).toContain('data-testid="pipeline-line"');
    expect(html).toMatch(/data-state="failed"[^>]*>[^<]*Switch/);
  });

  it("draws the pipeline of a deployment that runs", () => {
    const running = dep({ id: "d3", status: "running", finished_at: undefined, phases: [{ name: "release", status: "running", started_at: ago(5000) }] });
    const html = hero(app({ last_deployment: running }));
    expect(text(html)).toContain("Deploying now");
    expect(text(html)).toMatch(/Release.*In progress.*Switch.*Not started/);
  });

  it("does not warn after a deployment that worked", () => {
    expect(text(hero(app()))).not.toContain("Deploy failed");
  });

  it("warns that the stored variables changed after the serving deployment", () => {
    const html = hero(app({ env_changed_at: ago(HOUR) }), context({ deployments: { "s1/shop": [dep()] } }));
    expect(text(html)).toContain("Variables changed since the running version");
    expect(hero(app({ env_changed_at: ago(3 * HOUR) }), context({ deployments: { "s1/shop": [dep()] } }))).not.toContain("Variables changed");
  });

  it("says that nothing is serving instead of presenting an old version as live", () => {
    const stopped = app();
    stopped.container!.state = { ...stopped.container!.state, running: false, status: "exited" };
    const html = text(hero(stopped));
    expect(html).toContain("Last version that ran");
    expect(html).not.toContain("Serving now");
    expect(text(hero(app({ container: null, last_deployment: null })))).toContain("Nothing is serving");
  });

  it("says so when no address is known", () => {
    expect(text(hero(app({ domains: undefined })))).toContain("No public address known");
  });
});

describe("the other environments", () => {
  it("are compact rows that link to the environment and the site, and carry their own warnings", () => {
    const failed = dep({ id: "d2", status: "failed", started_at: ago(HOUR) });
    const [view] = views([place(app()), place(app({ name: "shop-test", environment: "test", domains: ["test.shop.example.com"], last_deployment: failed, env_changed_at: ago(30 * 60_000) }))], context({ deployments: { "s1/shop-test": [failed, dep({ id: "d0" })] } }));
    const html = renderToStaticMarkup(createElement(EnvironmentList, { environments: view.environments }));
    expect(count(html, '<li class="relative grid')).toBe(2);
    expect(html).toContain('href="/servers/s1/apps/shop-test"');
    expect(html).toContain('href="https://test.shop.example.com"');
    expect(text(html)).toContain("The last deployment failed");
    expect(text(html)).toContain("Variables changed since this version was deployed.");
  });
});

describe("the deployments of a project", () => {
  const entries = (list: Partial<DeploymentEntry>[]): DeploymentEntry[] => list.map((e) => ({ server, app: "shop", environment: "production", deployment: dep(), ...e }));
  const render = (list: DeploymentEntry[]) => renderToStaticMarkup(createElement(DeploymentFeed, { entries: list, context: context() }));

  it("links each row to its deployment, with the commit message, the environment, the trigger and the error of a failure", () => {
    const html = render(entries([{}, { deployment: dep({ id: "d2", status: "failed", ref: `ghcr.io/acme/shop:${SHA2}`, trigger: "api", error: "boom" }) }]));
    expect(html).toContain('href="/servers/s1/deployments/d1"');
    expect(html).toContain('href="/servers/s1/deployments/d2"');
    expect(text(html)).toContain("Fix the cart total");
    expect(text(html)).toContain("production");
    expect(text(html)).toContain("Push");
    expect(text(html)).toContain("boom");
    expect(text(html)).toContain("fedcba9");
  });

  it("draws the pipeline of a row that runs or failed, and none for one that worked or whose agent does not report phases", () => {
    const phases: Deployment["phases"] = [{ name: "release", status: "failed", started_at: ago(HOUR), finished_at: ago(HOUR - 3000) }];
    const html = render(entries([{ deployment: dep({ id: "d2", status: "failed", trigger: "api", phases }) }, { deployment: dep({ id: "d3", status: "failed", trigger: "api" }) }, { deployment: dep({ id: "d4", phases }) }]));
    expect(html.split('data-testid="pipeline-line"').length - 1).toBe(1);
    expect(text(html)).toContain("Release Failed");
  });

  it("calls a roll back that worked Rolled back to its version, not Succeeded, and the automatic return Deploy rolled back", () => {
    expect(text(render(entries([{ deployment: dep({ trigger: "rollback", ref: "ghcr.io/acme/shop:v1.2.0" }) }])))).toContain("Rolled back to v1.2.0");
    const automatic = text(render(entries([{ deployment: dep({ status: "rolled_back", trigger: "build" }) }])));
    expect(automatic).toContain("Deploy rolled back");
    expect(automatic).not.toContain("Rolled back to");
  });

  it("says a deployment came from another machine's build", () => {
    expect(text(render(entries([{ deployment: dep({ trigger: "transfer" }) }])))).toContain("built on builder-1");
  });

  it("says there is none yet instead of an empty list", () => {
    expect(render([])).toContain('data-slot="empty-state"');
  });
});

describe("the builds of a project", () => {
  const buildServer = { id: "b1", name: "builder-1", canDeploy: true };
  const history = [dep({ id: "b-3", trigger: "api" }), dep({ id: "b-2", ref: `ghcr.io/acme/shop:${SHA2}` }), dep({ id: "b-1" }), dep({ id: "b-0" })];
  // The builds of the other server name the commits of the app they build, as the page reads them (see loadProjectPage).
  const render = (builds: BuildsInfo | null, sourceHref: string | null = "/servers/s1/apps/shop/source") =>
    renderToStaticMarkup(createElement(BuildsCard, { builds, context: context({ sources: { "b1/shop": source } }), sourceHref }));

  it("keeps only the builds of the app on the build server, newest first, up to the limit", () => {
    const info = buildsOn(buildServer, "shop", history, 2);
    expect(info.recent.map((d) => d.id)).toEqual(["b-2", "b-1"]);
    expect(buildsOn(buildServer, "shop", null, 2).recent).toEqual([]);
  });

  it("names the server that builds, with a link to it, and its last builds", () => {
    const html = render(buildsOn(buildServer, "shop", history, 3));
    expect(text(html)).toMatch(/Builds run on builder-1 , then the image is sent to the server that runs the app\./);
    expect(html).toContain('href="/servers/b1"');
    expect(html).toContain('href="/servers/b1/deployments/b-2"');
    expect(html).not.toContain("b-3");
    expect(text(html)).toContain("Fix the cart total");
    expect(html).toContain('href="/servers/s1/apps/shop/source"');
  });

  it("says builds run where the app runs when it builds on its own server, and offers no link when the app is not linked", () => {
    const html = text(render(null, null));
    expect(html).toContain("Builds run on the server that runs the app.");
    expect(html).not.toContain("Change where it builds");
    expect(html).not.toContain("No build yet.");
  });

  it("says the other server has not built yet", () => {
    expect(text(render(buildsOn(buildServer, "shop", [], 3)))).toContain("No build yet.");
  });
});
