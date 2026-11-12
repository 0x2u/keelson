import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Container, Deployment, SystemInfo } from "@/lib/agent-types";
import { attentionItems } from "@/lib/attention-core";
import { serverRows, type FleetServerInput } from "@/lib/servers-view-core";

const { ServersList } = await import("@/components/servers/ServersList");

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const GIB = 1024 ** 3;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const system = (free = 60): SystemInfo => ({ time: ago(0), host: { cpus: 2, disk: { path: "/", total: 100 * GIB, free: free * GIB } } });
const container = (over: Partial<Container> = {}): Container => ({ id: "c1", name: "web-1", image: "nginx", state: "running", status: "Up 2 hours", ports: [], labels: {}, created: 0, ...over }) as Container;
const dep = (over: Partial<Deployment> = {}): Deployment => ({ id: "d1", app: "shop", ref: "shop:v2", status: "succeeded", trigger: "api", started_at: ago(HOUR), finished_at: ago(HOUR), ...over });

const ok = (id: string, name: string, over: Partial<FleetServerInput> = {}): FleetServerInput => ({
  server: { id, name },
  url: `http://${name}:7878`,
  transport: "direct",
  serves: false,
  canDeploy: true,
  reachable: true,
  lastSeen: NOW,
  version: "1.4.0",
  readOnly: false,
  system: system(),
  containers: [container(), container({ id: "c2", name: "worker", state: "exited", status: "Exited (0)" })],
  apps: [],
  jobs: [],
  databases: [],
  proxy: null,
  deployments: [dep()],
  ...over,
});
const down = (id: string, name: string, over: Partial<FleetServerInput> = {}): FleetServerInput => ({ server: { id, name }, url: `http://${name}:7878`, transport: "direct", serves: false, canDeploy: true, reachable: false, reason: "connect ECONNREFUSED", lastSeen: null, ...over });

const rowsOf = (servers: FleetServerInput[], bundled: string | null = "1.4.0") => serverRows(servers, attentionItems(servers, NOW), bundled);
const render = (servers: FleetServerInput[]) => renderToStaticMarkup(createElement(ServersList, { rows: rowsOf(servers) }));

describe("the rows of the servers page", () => {
  it("counts apps and running containers, finds the last deployment and the disk of a server that is fine", () => {
    const [row] = rowsOf([ok("s1", "alpha", { apps: [{ name: "a" } as never, { name: "b" } as never], deployments: [dep({ id: "old", started_at: ago(5 * HOUR) }), dep({ id: "new", app: "blog", status: "failed", started_at: ago(HOUR) })] })]);
    expect(row).toMatchObject({ id: "s1", reachable: true, apps: 2, containers: { running: 1, total: 2 }, lastDeployment: { id: "new", app: "blog", status: "failed" } });
    expect(row.disk).toMatchObject({ free: 60 * GIB, total: 100 * GIB, tone: "success" });
  });

  it("tells a server that is fine from one that needs attention, with the most urgent line", () => {
    const rows = rowsOf([ok("s1", "alpha", { containers: [container()], apps: [] }), ok("s2", "beta", { containers: [container({ name: "shop-1", state: "exited", status: "Exited (1)", labels: { "keelson.app": "shop" } })] })]);
    expect(rows.map((r) => r.name)).toEqual(["beta", "alpha"]);
    expect(rows[0].verdict).toMatchObject({ tone: "danger", count: 1 });
    expect(rows[0].headline).toContain("shop-1");
    expect(rows[1].verdict).toMatchObject({ tone: "success", count: 0 });
    expect(rows[1].headline).toBeUndefined();
  });

  it("puts unreachable servers first and leaves what it cannot know undefined, never zero", () => {
    const rows = rowsOf([ok("s1", "alpha"), down("s2", "zeta")]);
    expect(rows[0]).toMatchObject({ id: "s2", reachable: false, reason: "connect ECONNREFUSED", lastSeen: null, verdict: { tone: "danger", label: "Unreachable" } });
    expect(rows[0].apps).toBeUndefined();
    expect(rows[0].containers).toBeUndefined();
    expect(rows[0].lastDeployment).toBeUndefined();
    expect(rows[0].disk).toBeUndefined();
  });

  it("says an agent with no apps file has none (null), and one whose container list failed does not know its containers", () => {
    const [noFile] = rowsOf([ok("s1", "alpha", { apps: null, jobs: null, databases: null })]);
    expect(noFile.apps).toBeNull();
    const [failed] = rowsOf([ok("s1", "alpha", { containers: undefined, errors: { containers: "docker is down" } })]);
    expect(failed.containers).toBeUndefined();
  });

  it("offers an agent update when it is behind the bundled one, and says so when it is ahead instead of offering a downgrade", () => {
    expect(rowsOf([ok("s1", "alpha", { version: "1.3.0" })], "1.4.0")[0]).toMatchObject({ updateAvailable: true, newerThanDashboard: false });
    expect(rowsOf([ok("s1", "alpha", { version: "1.4.0" })], "1.4.0")[0]).toMatchObject({ updateAvailable: false, newerThanDashboard: false });
    expect(rowsOf([ok("s1", "alpha", { version: "1.5.0" })], "1.4.0")[0]).toMatchObject({ updateAvailable: false, newerThanDashboard: true });
    expect(rowsOf([ok("s1", "alpha", { version: "1.3.0" })], null)[0]).toMatchObject({ updateAvailable: false, newerThanDashboard: false });
    // builds named by a hash have no order: the update is offered, as it always was
    expect(rowsOf([ok("s1", "alpha", { version: "abc1234" })], "def5678")[0]).toMatchObject({ updateAvailable: true, newerThanDashboard: false });
  });

  it("lists an agent that is ahead of the dashboard as such, with no update link", () => {
    const behind = render([ok("s1", "alpha", { version: "1.3.0" })]);
    expect(behind).toContain("Update available");
    expect(behind).toContain('href="/servers/s1/update"');
    const ahead = render([ok("s1", "alpha", { version: "1.5.0" })]);
    expect(ahead).toContain("Newer than this dashboard");
    expect(ahead).not.toContain("Update available");
    expect(ahead).not.toContain("/servers/s1/update");
  });

  it("flags a disk that is nearly full", () => {
    expect(rowsOf([ok("s1", "alpha", { system: system(3) })])[0].disk?.tone).toBe("danger");
  });
});

describe("the servers page", () => {
  it("lists a healthy server with its status, version, counts, last deployment and disk, and links to it", () => {
    const html = render([ok("s1", "alpha")]);
    expect(html).toContain('href="/servers/s1"');
    expect(html).toContain("alpha");
    expect(html).toContain("Online");
    expect(html).toContain("1.4.0");
    expect(html).toMatch(/1<span[^>]*> of 2 running/);
    expect(html).toContain("Succeeded");
    expect(html).toContain("shop");
    expect(html).toMatch(/60(\.\d)? GB|60 GiB|60\.0 GiB/);
    expect(html).not.toContain("Can&#x27;t tell");
  });

  it("shows what is wrong on a server that needs attention, instead of Online", () => {
    const html = render([ok("s1", "alpha", { containers: [container({ name: "shop-1", state: "exited", status: "Exited (1)", labels: { "keelson.app": "shop" } })] })]);
    expect(html).toContain("1 thing needs attention");
    expect(html).toContain("Container shop-1 is exited");
    expect(html).not.toContain(">Online<");
  });

  it("shows an unreachable server as unreachable with why, and every number it cannot know as can't tell, never 0", () => {
    const html = render([down("s2", "zeta")]);
    expect(html).toContain("Unreachable");
    expect(html).toContain("connect ECONNREFUSED");
    expect(html).toContain("Never answered this dashboard");
    expect((html.match(/Can&#x27;t tell/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).not.toMatch(/ of 0 running/);
  });

  it("shows a read-only agent (no apps file) as having no apps and no deployments, not as can't tell", () => {
    const html = render([ok("s1", "alpha", { apps: null, jobs: null, databases: null, readOnly: true, deployments: undefined })]);
    expect(html).toContain("Read-only");
    expect(html).not.toContain("Can&#x27;t tell");
  });

  it("offers the update link of an out-of-date agent", () => {
    const rows = rowsOf([ok("s1", "alpha", { version: "1.3.0" })]);
    expect(renderToStaticMarkup(createElement(ServersList, { rows }))).toContain('href="/servers/s1/update"');
  });

  it("explains an empty fleet and offers to add the first server", () => {
    const html = render([]);
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain('href="/servers/new"');
  });
});

describe("a machine that connects out", () => {
  const machine = (over: Partial<FleetServerInput> = {}) => ok("m1", "marc-mac", { url: "", transport: "relay", deployments: [], containers: [], ...over });

  it("is listed as connecting to Keelson, with no address", () => {
    const out = render([machine()]);
    expect(out).toContain("Connects to Keelson");
    expect(out).not.toContain("http://");
    expect(rowsOf([machine()])[0]).toMatchObject({ machine: true, reachable: true, verdict: { count: 0 } });
  });

  it("is a server that runs apps when its agent was installed as one: an incident when it is not connected, updated from the dashboard's page", () => {
    const server = (over: Partial<FleetServerInput> = {}) => ok("r1", "vps-relay", { url: "", transport: "relay", serves: true, ...over });
    const [connected] = rowsOf([server({ version: "1.3.0" })]);
    expect(connected).toMatchObject({ relay: true, machine: false, reachable: true, updateAvailable: true });
    const rows = rowsOf([server({ reachable: false, reason: "cannot reach the agent: the agent on this server is not connected to the dashboard", lastSeen: NOW - HOUR }), ok("s2", "prod")]);
    expect(rows[0]).toMatchObject({ name: "vps-relay", relay: true, machine: false, verdict: { tone: "danger", label: "Unreachable" } });
    const out = render([server({ reachable: false, lastSeen: NOW - HOUR })]);
    expect(out).toContain("Unreachable");
    expect(out).toContain("Connects to Keelson");
    expect(out).not.toContain("builds images");
    expect(out).toContain("Last seen");
  });

  it("is Offline and last seen when it is not connected, never an incident that outranks a real one", () => {
    const rows = rowsOf([machine({ reachable: false, reason: "cannot reach the agent: the agent on this server is not connected to the dashboard", lastSeen: NOW - HOUR }), down("s2", "prod")]);
    expect(rows.map((r) => r.name)).toEqual(["prod", "marc-mac"]);
    expect(rows[1].verdict).toEqual({ tone: "muted", label: "Offline", count: 0 });
    const out = render([machine({ reachable: false, lastSeen: NOW - HOUR })]);
    expect(out).toContain("Offline");
    expect(out).toContain("Last seen");
    expect(out).not.toContain("Unreachable");
  });
});
