import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStatus, Container, DatabaseStatus, Deployment, JobStatus, ProxyView } from "@/lib/agent-types";
import type { ServerSnapshot } from "@/lib/attention-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-server-pages-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVER = { id: "s1", name: "vps-1", url: "http://127.0.0.1:7878", canDeploy: true, transport: "direct", serves: false };

// Every loader a server page can call, as a mock: a tab page must call its own and no other.
const loaders = vi.hoisted(() => ({
  serverInfo: vi.fn(),
  serverSystem: vi.fn(),
  serverContainers: vi.fn(),
  serverApps: vi.fn(),
  serverJobs: vi.fn(),
  serverDatabases: vi.fn(),
  serverProxy: vi.fn(),
  serverDeployments: vi.fn(),
  serverDisk: vi.fn(),
  serverHostHistory: vi.fn(),
  databaseBackups: vi.fn(),
  serverAnswers: vi.fn(),
  serverSnapshot: vi.fn(),
}));
vi.mock("@/lib/server-data", () => loaders);
vi.mock("@/lib/data", () => ({ loadServer: () => SERVER, load: async (p: Promise<unknown>) => ({ data: await p }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
  usePathname: () => "/servers/s1",
  useRouter: () => ({ refresh() {} }),
}));
vi.mock("@/components/RunJobButton", () => ({ RunJobButton: () => null }));
vi.mock("@/components/databases/RefreshWhile", () => ({ RefreshWhile: () => null }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { default: ContainersPage } = await import("@/app/(app)/servers/[id]/(tabs)/containers/page");
const { default: ProxyPage } = await import("@/app/(app)/servers/[id]/(tabs)/proxy/page");
const { default: JobsRedirect } = await import("@/app/(app)/servers/[id]/jobs/page");
const { default: DatabasesRedirect } = await import("@/app/(app)/servers/[id]/databases/page");
const { default: OverviewPage } = await import("@/app/(app)/servers/[id]/(tabs)/page");
const { ServerTabsBar } = await import("@/components/servers/ServerTabsBar");
const { ScheduledSection, StatusSection } = await import("@/components/servers/ServerOverview");

const params = Promise.resolve({ id: "s1" });
const ok = <T>(data: T) => Promise.resolve({ data });
const fail = (error: string) => Promise.resolve({ error });

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const container = (over: Partial<Container> = {}): Container =>
  ({ id: "c1", name: "web-1", image: "nginx:alpine", state: "running", status: "Up 2 hours", ports: [{ ip: "127.0.0.1", private_port: 80, public_port: 18080, type: "tcp" }], labels: {}, created: 0, ...over }) as Container;
const job = (over: Partial<JobStatus> = {}): JobStatus => ({ name: "nightly", schedule: "0 3 * * *", timezone: "UTC", kind: "http", target: "GET http://x", paused: false, running: false, ...over });
const database = (): DatabaseStatus => ({
  name: "kv-pg",
  engine: "postgres",
  host: "db",
  port: 5432,
  database: "kv",
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: "backup-kv-pg", next_run: ago(-3_600_000), last_run: null },
});
const proxy = (over: Partial<ProxyView> = {}): ProxyView => ({ type: "caddy", where: "http://127.0.0.1:2019", generated: "{}", in_sync: true, routes: [], unrouted: [], ...over });

async function html(element: unknown): Promise<string> {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element as ReactElement));
}

const everyLoader = () => Object.entries(loaders);
function expectOnly(...allowed: (keyof typeof loaders)[]) {
  for (const [name, mock] of everyLoader()) {
    if (allowed.includes(name as keyof typeof loaders)) continue;
    expect(mock, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  for (const [, mock] of everyLoader()) mock.mockReset();
  loaders.serverInfo.mockImplementation(() => ok({ version: "1.4.0", read_only: false }));
  loaders.serverContainers.mockImplementation(() => ok([container()]));
  loaders.serverJobs.mockImplementation(() => ok([job()]));
  loaders.serverDatabases.mockImplementation(() => ok([database()]));
  loaders.databaseBackups.mockImplementation(() => ok([]));
  loaders.serverProxy.mockImplementation(() => ok(proxy()));
  loaders.serverApps.mockImplementation(() => ok([] as AppStatus[]));
  loaders.serverDeployments.mockImplementation(() => ok([] as Deployment[]));
  loaders.serverSystem.mockImplementation(() => ok(null));
  loaders.serverDisk.mockImplementation(() => ok(null));
  loaders.serverHostHistory.mockImplementation(() => ok(null));
});

describe("each tab page loads only its own data", () => {
  it("Containers reads the containers and nothing else, and shows state and ports", async () => {
    const out = await html(await ContainersPage({ params }));
    expectOnly("serverContainers");
    expect(loaders.serverContainers).toHaveBeenCalledWith("s1");
    expect(out).toContain("web-1");
    expect(out).toContain("Running");
    // The ports are in the row twice: under the name for a phone, and in their own column for a wide screen.
    expect(out.match(/18080→80/g)).toHaveLength(2);
    expect(out).toMatch(/data-testid="container-ports-compact">18080→80</);
  });


  it("Proxy reads the proxy and nothing else", async () => {
    const element = await ProxyPage({ params });
    expectOnly("serverProxy");
    expect(isValidElement(element)).toBe(true);
    expect(loaders.serverProxy).toHaveBeenCalledWith("s1");
  });


  it("Overview reads what it shows (health, apps, deployments, disk) but never the jobs, databases or proxy", async () => {
    await OverviewPage({ params, searchParams: Promise.resolve({}) });
    expectOnly("serverInfo", "serverSystem", "serverContainers", "serverDisk", "serverHostHistory");
    // Its sections load the rest when they render.
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve({ server: SERVER, reachable: true, lastSeen: NOW } satisfies ServerSnapshot));
    const { AppsSection, DeploymentsSection } = await import("@/components/servers/ServerOverview");
    await StatusSection({ serverId: "s1" });
    await AppsSection({ serverId: "s1", canDeploy: true });
    await DeploymentsSection({ serverId: "s1" });
    expect(loaders.serverJobs).not.toHaveBeenCalled();
    expect(loaders.serverDatabases).not.toHaveBeenCalled();
    expect(loaders.serverProxy).not.toHaveBeenCalled();
  });
});

describe("a tab whose data cannot be read says so instead of looking empty", () => {
  it("Containers", async () => {
    loaders.serverContainers.mockImplementation(() => fail("connect ECONNREFUSED"));
    const out = await html(await ContainersPage({ params }));
    expect(out).toContain("Containers could not be listed");
    expect(out).toContain("connect ECONNREFUSED");
    expect(out).not.toContain("No container on this server");
  });
});

describe("the server's Jobs and Databases addresses", () => {
  const target = async (page: (props: { params: Promise<{ id: string }> }) => Promise<unknown>, id = "s1") => {
    try {
      await page({ params: Promise.resolve({ id }) });
    } catch (err) {
      return (err as { to?: string }).to;
    }
    return undefined;
  };

  it("redirect to the global list narrowed to the server, before anything is loaded", async () => {
    expect(await target(JobsRedirect)).toBe("/jobs?server=s1");
    expect(await target(DatabasesRedirect)).toBe("/databases?server=s1");
    expect(await target(JobsRedirect, "a%20b")).toBe("/jobs?server=a%20b");
    expectOnly();
  });

  it("count the server's jobs and databases on its overview, as links to those lists", async () => {
    loaders.serverSnapshot.mockImplementation(() =>
      Promise.resolve({ server: SERVER, reachable: true, lastSeen: NOW, apps: [], jobs: [job(), job({ name: "other" })], databases: [database()], containers: [], proxy: null } satisfies ServerSnapshot),
    );
    const out = await html(await ScheduledSection({ serverId: "s1" }));
    expect(out).toContain('data-testid="server-lists"');
    expect(out).toContain('href="/jobs?server=s1"');
    expect(out).toContain('href="/databases?server=s1"');
    expect(out).toContain("Jobs on this server: 2");
    expect(out).toContain("Databases on this server: 1");
  });

  it("leave out a list the agent does not offer, and everything for an agent that is down", async () => {
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve({ server: SERVER, reachable: true, lastSeen: NOW, apps: null, jobs: null, databases: [database()] } satisfies ServerSnapshot));
    const out = await html(await ScheduledSection({ serverId: "s1" }));
    expect(out).not.toContain("/jobs?server=");
    expect(out).toContain("/databases?server=s1");
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve({ server: SERVER, reachable: false, reason: "down", lastSeen: null } satisfies ServerSnapshot));
    expect(await html(await ScheduledSection({ serverId: "s1" }))).not.toContain("server-lists");
  });

  it("say which jobs and databases need a look", async () => {
    loaders.serverSnapshot.mockImplementation(() =>
      Promise.resolve({
        server: SERVER,
        reachable: true,
        lastSeen: NOW,
        apps: [],
        jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", detail: "HTTP 500", started_at: ago(60_000), finished_at: ago(60_000) } })],
        databases: [],
      } satisfies ServerSnapshot),
    );
    expect(await html(await ScheduledSection({ serverId: "s1" }))).toContain("1 need a look");
  });
});

describe("old ?tab= links", () => {
  const redirected = async (tab: string | string[]) => {
    try {
      await OverviewPage({ params, searchParams: Promise.resolve({ tab }) });
    } catch (err) {
      return (err as { to?: string }).to;
    }
    return undefined;
  };

  it("redirect to the route of the tab, before anything is loaded; the jobs and databases tabs are the global lists", async () => {
    expect(await redirected("containers")).toBe("/servers/s1/containers");
    expect(await redirected("proxy")).toBe("/servers/s1/proxy");
    expect(await redirected("jobs")).toBe("/jobs?server=s1");
    expect(await redirected("databases")).toBe("/databases?server=s1");
    expect(await redirected("overview")).toBe("/servers/s1");
    expect(await redirected("whatever")).toBe("/servers/s1");
    expectOnly();
  });
});

describe("the tab bar", () => {
  const snapshot = (over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({ server: SERVER, reachable: true, lastSeen: NOW, apps: [], jobs: [], databases: [], containers: [], proxy: null, ...over });
  const barProps = async (s: ServerSnapshot) => {
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve(s));
    const element = (await ServerTabsBar({ serverId: "s1", machine: false })) as ReactElement<{ tabs: { id: string; count?: number; attention?: { tone: string } }[] }>;
    return element.props.tabs;
  };

  it("gets a dot on the tab the attention model has items for, from the one snapshot (jobs and databases are no tabs)", async () => {
    const tabs = await barProps(
      snapshot({
        containers: [container({ name: "shop-1", state: "exited", status: "Exited (1)", labels: { "keelson.app": "shop" } })],
        proxy: proxy({ in_sync: false }),
        jobs: [job({ last_run: { id: "r", job: "nightly", trigger: "schedule", status: "failed", detail: "HTTP 500", started_at: ago(60_000), finished_at: ago(60_000) } })],
        databases: [database()],
      }),
    );
    expect(tabs.filter((t) => t.attention).map((t) => [t.id, t.attention?.tone])).toEqual([["containers", "danger"], ["proxy", "warning"]]);
    expect(tabs.map((t) => t.id)).toEqual(["overview", "containers", "proxy"]);
    expect(tabs.find((t) => t.id === "containers")?.count).toBe(1);
    expectOnly("serverSnapshot");
  });

  it("has no dot on a server that is fine", async () => {
    const tabs = await barProps(snapshot({ containers: [container()] }));
    expect(tabs.filter((t) => t.attention)).toEqual([]);
  });
});

describe("the overview's status", () => {
  it("lists the server's attention items and leaves out the link to the page it is on", async () => {
    loaders.serverSnapshot.mockImplementation(() =>
      Promise.resolve({ server: SERVER, reachable: true, lastSeen: NOW, containers: [container({ name: "shop-1", state: "exited", status: "Exited (1)", labels: { "keelson.app": "shop" } })], apps: [], jobs: [], databases: [], proxy: proxy({ in_sync: false }) } satisfies ServerSnapshot),
    );
    const out = await html(await StatusSection({ serverId: "s1" }));
    expect(out).toContain('data-testid="server-attention"');
    expect(out).toContain("2 things need attention");
    expect(out).toContain("Container shop-1 is exited");
    expect(out).toContain('href="/servers/s1/proxy"');
    expect(out).not.toContain('href="/servers/s1"');
  });

  it("says everything is fine for a healthy server", async () => {
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve({ server: SERVER, reachable: true, lastSeen: NOW, containers: [container()], apps: [], jobs: [], databases: [], proxy: null } satisfies ServerSnapshot));
    const out = await html(await StatusSection({ serverId: "s1" }));
    expect(out).toContain("Online");
    expect(out).not.toContain("server-attention");
  });

  it("says the agent cannot be reached, with why, for an unreachable server", async () => {
    loaders.serverSnapshot.mockImplementation(() => Promise.resolve({ server: SERVER, reachable: false, reason: "connect ECONNREFUSED", lastSeen: null } satisfies ServerSnapshot));
    const out = await html(await StatusSection({ serverId: "s1" }));
    expect(out).toContain("The agent cannot be reached");
    expect(out).toContain("connect ECONNREFUSED");
    expect(out).not.toContain("Online");
  });
});
