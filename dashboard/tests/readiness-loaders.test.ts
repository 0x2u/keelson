import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppStatus, DatabaseStatus, Deployment } from "@/lib/agent-types";
import type { FleetServer } from "@/lib/fleet";
import { FakeReadinessAgent } from "./fake-readiness-agent";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-readiness-loaders-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
// The agent this dashboard carries: the version the fake agents report.
process.env.KEELSON_AGENT_BIN_DIR = dir;
writeFileSync(path.join(dir, "VERSION"), "v1\n");

vi.mock("next/navigation", () => ({ notFound: () => Promise.reject(new Error("not found")) }));

const { loadFleetReadiness, loadServerReadiness } = await import("@/lib/readiness");
const { forProject, ownedKey, readinessSummary } = await import("@/lib/readiness-core");
const servers = await import("@/lib/servers");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 86_400_000;

const app = (name: string, project: string): AppStatus =>
  ({ name, image: `r:${name}`, project, environment: "", digest: "", container: { id: "c", name, image: "r:v2", created: "", tty: false, restart_count: 0, state: { status: "running", running: true, paused: false, restarting: false, oom_killed: false, exit_code: 0 }, ports: null }, last_deployment: null }) as AppStatus;
const database = (name: string): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "db",
  port: 5432,
  database: name,
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "s3:bk/p", recipients: 1, job: `backup-${name}`, next_run: ago(-3_600_000), last_run: { id: "r", status: "succeeded", started_at: ago(3_600_000), finished_at: ago(3_600_000) } },
});
const dep = (ref: string, minute: number): Deployment => ({ id: `d${minute}`, app: "shop", ref, status: "succeeded", trigger: "api", started_at: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z` });

const model = {
  apps: [{ name: "shop", project: "shop", image: "r:shop", health_path: "/healthz" }, { name: "blog", image: "r:blog" }],
  databases: [{ name: "shop-db", host: "db", database: "shop", user: "u", project: "shop", backups: { schedule: "0 3 * * *", recipients: ["age1x"], destinations: [{ s3: { endpoint: "https://s3.example.com", region: "r", bucket: "bucket1", access_key_id: "k", secret_key_file: "/f" } }] } }],
  notifications: { telegram: { bot_token_file: "/t", chat_id: "1" } },
};

const agent = new FakeReadinessAgent({
  version: "v1",
  apps: [app("shop", "shop"), app("blog", "")],
  databases: [database("shop-db")],
  model,
  deployments: { shop: [dep("r:v2", 30), dep("r:v1", 10)], blog: [] },
  proofs: [
    { kind: "restore", subject: "shop-db", at: ago(5 * DAY) },
    { kind: "key", subject: "shop-db", at: ago(100 * DAY) },
  ],
});
const old = new FakeReadinessAgent({ version: "v1", apps: [app("shop", "shop")], databases: [database("shop-db")], model, old: true, deployments: { shop: [dep("r:v2", 30)] } });
let id = "";
let oldId = "";
beforeAll(async () => {
  await agent.start();
  await old.start();
  id = servers.createServer({ name: "alpha", url: agent.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
  oldId = servers.createServer({ name: "ancient", url: old.url, token: "t".repeat(40), deploySecret: "s".repeat(40) });
});
afterAll(async () => {
  await agent.stop();
  await old.stop();
  rmSync(dir, { recursive: true, force: true });
});

const base = (serverId: string, name: string, a: FakeReadinessAgent) => ({ server: { id: serverId, name }, reachable: true, version: "v1", apps: a.opts.apps, databases: a.opts.databases });

describe("what is read for one server", () => {
  it("judges its databases, apps and itself from the agent's configuration and proofs", async () => {
    const items = await loadServerReadiness(base(id, "alpha", agent), NOW);
    const by = (check: string, subject?: string) => items.find((i) => i.check === check && (subject === undefined || i.subject === subject));
    expect(by("backup")?.state).toBe("ok");
    expect(by("offsite")?.state).toBe("ok");
    expect(by("restore")).toMatchObject({ state: "ok", fix: "test-restore" });
    expect(by("key")).toMatchObject({ state: "warning" });
    expect(by("alert")).toMatchObject({ state: "todo", fix: "test-alert" });
    expect(by("health", "shop")?.state).toBe("ok");
    expect(by("health", "blog")?.state).toBe("todo");
    expect(by("rollback", "shop")?.state).toBe("ok");
    // It serves, but no deployment of it succeeded on record: there is nothing to go back to.
    expect(by("rollback", "blog")?.state).toBe("todo");
    expect(by("versions")?.state).toBe("ok");
  });

  it("asks for what it needs and nothing else: no scan of other servers, no write", async () => {
    agent.requests.length = 0;
    await loadServerReadiness(base(id, "alpha", agent), NOW);
    expect(agent.requests.every((r) => r.method === "GET")).toBe(true);
    const lines = agent.requests.map((r) => r.url).sort();
    expect(lines).toEqual(expect.arrayContaining(["/v1/config", "/v1/proofs", "/v1/databases/shop-db/restore-tests?limit=5", "/v1/deployments?limit=50&app=shop"]));
  });

  it("is 'update the agent' for every proof-based check on an agent without the routes, and still answers the rest", async () => {
    const items = await loadServerReadiness(base(oldId, "ancient", old), NOW);
    for (const check of ["restore", "key", "alert"]) {
      const i = items.find((x) => x.check === check);
      expect(i?.state, check).toBe("todo");
      expect(i?.detail, check).toContain("too old");
      expect(i?.action?.href, check).toBe(`/servers/${oldId}/update`);
    }
    expect(items.find((i) => i.check === "backup")?.state).toBe("ok");
  });

  it("reads nothing from a server that did not answer, and says so as one item", async () => {
    const items = await loadServerReadiness({ server: { id: "x", name: "gone" }, reachable: false, reason: "connect ECONNREFUSED" }, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ check: "reachable", state: "todo" });
  });
});

describe("what is read for the fleet", () => {
  const fleetServer = (serverId: string, name: string, a: FakeReadinessAgent): FleetServer =>
    ({ server: { id: serverId, name }, reachable: true, lastSeen: NOW, url: a.url, transport: "direct", serves: true, canDeploy: true, version: "v1", apps: a.opts.apps, databases: a.opts.databases, jobs: [] }) as FleetServer;

  it("names the project of each database and app by the hub's own rule, and counts every check once", async () => {
    const items = await loadFleetReadiness([fleetServer(id, "alpha", agent)], NOW);
    expect(items.filter((i) => i.project === "shop").map((i) => `${i.check}:${i.subject}`).sort()).toEqual(["backup:shop-db", "health:shop", "key:shop-db", "offsite:shop-db", "restore:shop-db", "rollback:shop"]);
    // The unlabelled app and the dashboard's own items belong to no project's databases.
    expect(items.find((i) => i.check === "health" && i.subject === "blog")?.project).toBe("blog");
    expect(items.some((i) => i.scope === "dashboard")).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("agrees with the project's own tab: the same items, the same verdict", async () => {
    const items = await loadFleetReadiness([fleetServer(id, "alpha", agent)], NOW);
    const own = { name: "shop", servers: [id], databases: new Set([ownedKey(id, "shop-db")]), apps: new Set([ownedKey(id, "shop")]) };
    const tab = forProject(items, own);
    expect(tab.filter((i) => i.scope === "project").map((i) => i.id).sort()).toEqual(items.filter((i) => i.project === "shop").map((i) => i.id).sort());
    expect(readinessSummary(tab).total).toBeGreaterThan(0);
  });
});
