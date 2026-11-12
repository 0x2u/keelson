import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sign } from "@/lib/sign";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-api-v1-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
process.env.KEELSON_AGENT_BIN_DIR = dir;

const { db } = await import("@/lib/db");
const tokens = await import("@/lib/api-tokens");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");
const { LOG_BYTES_MAX } = await import("@/lib/api-v1-streams");

// The routes, called as Next calls them: a Request and the promise of the path parameters.
type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const handlers: Record<string, Record<"GET" | "POST", Handler>> = {
  servers: await import("@/app/api/v1/servers/route"),
  "servers/[id]/overview": await import("@/app/api/v1/servers/[id]/overview/route"),
  "servers/[id]/apps": await import("@/app/api/v1/servers/[id]/apps/route"),
  "servers/[id]/deployments": await import("@/app/api/v1/servers/[id]/deployments/route"),
  "servers/[id]/deployments/[deployment]": await import("@/app/api/v1/servers/[id]/deployments/[deployment]/route"),
  "servers/[id]/containers/[name]/logs": await import("@/app/api/v1/servers/[id]/containers/[name]/logs/route"),
  "servers/[id]/jobs": await import("@/app/api/v1/servers/[id]/jobs/route"),
  "servers/[id]/jobs/[name]/runs": await import("@/app/api/v1/servers/[id]/jobs/[name]/runs/route"),
  "servers/[id]/databases": await import("@/app/api/v1/servers/[id]/databases/route"),
  "servers/[id]/previews": await import("@/app/api/v1/servers/[id]/previews/route"),
  "servers/[id]/proxy": await import("@/app/api/v1/servers/[id]/proxy/route"),
  projects: await import("@/app/api/v1/projects/route"),
  audit: await import("@/app/api/v1/audit/route"),
  "servers/[id]/apps/[app]/deploy": await import("@/app/api/v1/servers/[id]/apps/[app]/deploy/route"),
  "servers/[id]/apps/[app]/rollback": await import("@/app/api/v1/servers/[id]/apps/[app]/rollback/route"),
  "servers/[id]/jobs/[name]/run": await import("@/app/api/v1/servers/[id]/jobs/[name]/run/route"),
} as never;
const route = (file: string) => handlers[file];

const AGENT_TOKEN = "AGENT-TOKEN-" + "t".repeat(30);
const DEPLOY_SECRET = "DEPLOY-SECRET-" + "s".repeat(30);
const CLIENT_KEY = "-----BEGIN PRIVATE KEY-----\nCLIENT-KEY-MATERIAL\n-----END PRIVATE KEY-----";
const CA_CERT = "-----BEGIN CERTIFICATE-----\nCA-CERT-MATERIAL\n-----END CERTIFICATE-----";
const CLIENT_CERT = "-----BEGIN CERTIFICATE-----\nCLIENT-CERT-MATERIAL\n-----END CERTIFICATE-----";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let agent: Server;
let base: string;
const seen: Seen[] = [];
/** What the fake agent answers to the next calls; a test replaces entries and afterEach resets them. */
const overrides = new Map<string, (req: Seen) => { status: number; body: unknown } | "sse">();
let sseBody = sse([["end", {}]]);

const DEPLOYMENT = { id: "dep1", app: "shop", ref: "shop:v1", status: "succeeded", trigger: "api", started_at: "2026-01-01T00:00:00Z" };
const CONTAINER = {
  id: "c1",
  name: "shop",
  image: "shop:v1",
  image_id: "sha256:x",
  command: "node server.js --db-password=hunter2",
  created: 1,
  state: "running",
  status: "Up",
  labels: { "keelson.app": "shop" },
  ports: [],
};
const APP = { name: "shop", image: "shop", project: "shop", environment: "production", digest: "", container: null, last_deployment: DEPLOYMENT, env_changed_at: "2026-01-01T12:00:00Z" };
const BACKUP = { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: "backup-main", next_run: "2026-01-02T03:00:00Z", last_run: { id: "r", status: "succeeded", started_at: "2026-01-01T03:00:00Z" } };

function sse(events: [string, unknown][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const routes: Record<string, (req: Seen) => unknown> = {
  "GET /v1/containers/shop/logs": () => "sse",
  "GET /v1/deployments/dep1/events": () => "sse",
  "GET /v1/info": () => ({ version: "v1.2.3", read_only: false }),
  "GET /v1/system": () => ({ time: "2026-01-01T00:00:00Z", host: { cpus: 2 } }),
  "GET /v1/containers": () => [CONTAINER],
  "GET /v1/apps": () => [APP],
  "GET /v1/deployments": () => [DEPLOYMENT],
  "GET /v1/deployments/dep1": () => DEPLOYMENT,
  "GET /v1/jobs": () => [{ name: "nightly", schedule: "0 1 * * *", timezone: "UTC", kind: "http", target: "GET http://x", paused: false, running: false }],
  "GET /v1/jobs/nightly/runs": () => [{ id: "run1", job: "nightly", trigger: "schedule", status: "succeeded", output: "x".repeat(40_000), started_at: "2026-01-01T00:00:00Z" }],
  "GET /v1/databases": () => [{ name: "main", engine: "postgres", host: "db", port: 5432, database: "app", user: "app", version: 16, network: "", has_password: true, backup: BACKUP }],
  "GET /v1/previews": () => ({ previews: [{ name: "shop-pr-1", app: "shop", pr: 1, domain: "pr1.example.com", url: "https://pr1.example.com", ref: "abc", status: "running", deployment_id: "d", created_at: "", updated_at: "", expires_at: "" }] }),
  "GET /v1/proxy": () => ({ type: "caddy", where: "http://caddy:2019", generated: "{}", in_sync: true, routes: [], unrouted: [] }),
  "POST /v1/apps/shop/deploy": () => ({ deployment_id: "dep2" }),
  "POST /v1/apps/shop/rollback": () => ({ deployment_id: "dep3" }),
  "POST /v1/jobs/nightly/run": () => ({ run_id: "run2" }),
};

let good: string; // a server that answers
let dead: string; // a server that does not
let readOnly: string; // no deploy secret
const mint = (over: Partial<{ name: string; scope: "read" | "deploy"; servers: string[] | null; days: number }> = {}, now = Date.now()) =>
  tokens.createApiToken({ name: "ci", scope: "read", servers: null, days: 30, ...over }, now);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  agent = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      const pathOnly = (req.url ?? "").split("?")[0];
      const key = `${req.method} ${pathOnly}`;
      const custom = overrides.get(key);
      const result = custom ? custom(entry) : undefined;
      if (result === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sseBody);
        return;
      }
      if (result) {
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
      const handler = routes[key];
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const answer = handler(entry);
      if (answer === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sseBody);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
  good = servers.createServer({ name: "prod", url: base, token: AGENT_TOKEN, deploySecret: DEPLOY_SECRET, caCert: CA_CERT, clientCert: CLIENT_CERT, clientKey: CLIENT_KEY });
  // A port that was free a moment ago and has nobody listening: connection refused.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  dead = servers.createServer({ name: "dead", url: `http://127.0.0.1:${closedPort}`, token: AGENT_TOKEN, deploySecret: DEPLOY_SECRET });
  readOnly = servers.createServer({ name: "readonly", url: base, token: AGENT_TOKEN });
});
afterAll(async () => {
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const table of ["api_tokens", "audit_log", "login_failures"]) db().exec(`DELETE FROM ${table}`);
  seen.length = 0;
});
afterEach(() => {
  sseBody = sse([["end", {}]]);
  overrides.clear();
  delete process.env.KEELSON_TRUST_PROXY;
});

async function get(file: string, token: string | null, params: Record<string, string> = {}, query = "", headers: Record<string, string> = {}): Promise<Response> {
  const { GET } = route(file);
  return GET(new Request(`http://dash/api/v1/${file}${query}`, { headers: { ...(token ? auth(token) : {}), ...headers } }), { params: Promise.resolve(params) });
}
async function post(file: string, token: string, params: Record<string, string>, body?: unknown, raw?: string): Promise<Response> {
  const { POST } = route(file);
  return POST(new Request(`http://dash/api/v1/${file}`, { method: "POST", headers: auth(token), body: raw ?? (body === undefined ? "" : JSON.stringify(body)) }), { params: Promise.resolve(params) });
}

/** Every read endpoint with what it needs, and the key its answer is about. */
const READS = (): { file: string; params: Record<string, string>; query?: string; key: string }[] => [
  { file: "servers", params: {}, key: "servers" },
  { file: "servers/[id]/overview", params: { id: good }, key: "server" },
  { file: "servers/[id]/apps", params: { id: good }, key: "apps" },
  { file: "servers/[id]/deployments", params: { id: good }, key: "deployments" },
  { file: "servers/[id]/deployments/[deployment]", params: { id: good, deployment: "dep1" }, key: "events" },
  { file: "servers/[id]/containers/[name]/logs", params: { id: good, name: "shop" }, key: "lines" },
  { file: "servers/[id]/jobs", params: { id: good }, key: "jobs" },
  { file: "servers/[id]/jobs/[name]/runs", params: { id: good, name: "nightly" }, key: "runs" },
  { file: "servers/[id]/databases", params: { id: good }, key: "databases" },
  { file: "servers/[id]/previews", params: { id: good }, key: "previews" },
  { file: "servers/[id]/proxy", params: { id: good }, key: "proxy" },
  { file: "projects", params: {}, key: "projects" },
  { file: "audit", params: {}, key: "entries" },
];
const WRITES = (): { file: string; params: Record<string, string>; body?: unknown }[] => [
  { file: "servers/[id]/apps/[app]/deploy", params: { id: good, app: "shop" }, body: { tag: "v1" } },
  { file: "servers/[id]/apps/[app]/rollback", params: { id: good, app: "shop" } },
  { file: "servers/[id]/jobs/[name]/run", params: { id: good, name: "nightly" } },
];

describe("authentication", () => {
  it("answers every kind of bad token with the same 401, uncached, and does not tell them apart", async () => {
    const revoked = mint({ name: "revoked" });
    tokens.revokeApiToken(revoked.record.id);
    const expired = mint({ name: "expired", days: 1 }, Date.now() - 2 * 24 * 60 * 60 * 1000);
    const unknown = "kst_" + "A".repeat(43);
    const cases: [string, string | null][] = [
      ["no header", null],
      ["unknown", unknown],
      ["revoked", revoked.token],
      ["expired", expired.token],
    ];
    const bodies = new Set<string>();
    for (const [label, token] of cases) {
      const res = await get("servers", token);
      expect(res.status, label).toBe(401);
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      bodies.add(await res.text());
    }
    const malformed = await route("servers").GET(new Request("http://dash/api/v1/servers", { headers: { Authorization: "Basic abc" } }), { params: Promise.resolve({}) });
    expect(malformed.status).toBe(401);
    bodies.add(await malformed.text());
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it("does not audit a 401 line by line, and counts it for the throttle", async () => {
    for (let i = 0; i < 3; i++) await get("servers", null);
    expect(store.recentAudit(10)).toEqual([]);
    expect(store.isLoginBlocked("api:local")).toBe(false);
    for (let i = 0; i < 2; i++) await get("servers", null);
    expect(store.isLoginBlocked("api:local")).toBe(true);
  });

  it("answers a client that failed five times with 429 and Retry-After, valid token or not, but only that client", async () => {
    process.env.KEELSON_TRUST_PROXY = "true";
    const { token } = mint();
    for (let i = 0; i < 5; i++) expect((await get("servers", null, {}, "", { "x-forwarded-for": "203.0.113.9" })).status).toBe(401);
    const blocked = await get("servers", token, {}, "", { "x-forwarded-for": "203.0.113.9" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(15 * 60);
    expect((await blocked.json()) as unknown).toEqual({ error: "too many failed attempts" });
    expect((await get("servers", token, {}, "", { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    // The sign-in throttle of that address is a different key: guessing tokens cannot lock the operator out.
    expect(store.isLoginBlocked("203.0.113.9")).toBe(false);
  });

  it("records a use, at most once a minute", async () => {
    const { token, record } = mint();
    await get("servers", token);
    const first = tokens.getApiToken(record.id)!;
    expect(first.lastUsedAt).not.toBeNull();
    expect(first.lastUsedIp).toBe("local");
    await get("servers", token);
    expect(tokens.getApiToken(record.id)!.lastUsedAt).toBe(first.lastUsedAt);
  });

  it("takes a revocation into account on the very next call", async () => {
    const { token, record } = mint();
    expect((await get("servers", token)).status).toBe(200);
    tokens.revokeApiToken(record.id);
    expect((await get("servers", token)).status).toBe(401);
  });
});

describe("scopes and server limits, on every endpoint", () => {
  it("lets a read token and a deploy token read everything", async () => {
    for (const scope of ["read", "deploy"] as const) {
      db().exec("DELETE FROM api_tokens");
      const { token } = mint({ scope });
      for (const r of READS()) {
        const res = await get(r.file, token, r.params, r.query);
        expect(res.status, `${scope} ${r.file}`).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(Object.keys((await res.json()) as object), r.file).toContain(r.key);
      }
    }
  });

  it("refuses a read token the three writes with a 403, audits it under the token's name, and asks the agent nothing", async () => {
    const { token } = mint({ name: "reader" });
    for (const w of WRITES()) {
      const res = await post(w.file, token, w.params, w.body);
      expect(res.status, w.file).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/^forbidden: /);
    }
    expect(seen).toEqual([]);
    const lines = store.recentAudit(10);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect([line.event, line.actor]).toEqual(["api_denied", "token:reader"]);
  });

  it("lets a deploy token do the three writes", async () => {
    const { token } = mint({ scope: "deploy" });
    for (const w of WRITES()) expect((await post(w.file, token, w.params, w.body)).status, w.file).toBe(202);
  });

  it("refuses a token limited to other servers on every endpoint about a server, 403 even for a server that does not exist", async () => {
    const { token } = mint({ scope: "deploy", servers: [readOnly] });
    for (const r of READS().filter((x) => x.params.id !== undefined)) {
      const res = await get(r.file, token, r.params);
      expect(res.status, r.file).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/^forbidden: /);
    }
    for (const w of WRITES()) expect((await post(w.file, token, w.params, w.body)).status, w.file).toBe(403);
    expect((await get("servers/[id]/apps", token, { id: "nonexistent" })).status).toBe(403);
    expect(seen).toEqual([]);
    expect(store.recentAudit(50).every((e) => e.event === "api_denied" && e.actor === "token:ci")).toBe(true);
  });

  it("answers 404 for a server that does not exist to a token that could see any", async () => {
    const { token } = mint();
    expect((await get("servers/[id]/apps", token, { id: "nonexistent" })).status).toBe(404);
  });

  it("shows a limited token only its servers, in the list and in the projects", async () => {
    const { token } = mint({ servers: [readOnly] });
    const list = (await (await get("servers", token)).json()) as { servers: { id: string }[] };
    expect(list.servers.map((s) => s.id)).toEqual([readOnly]);
    const projects = (await (await get("projects", token)).json()) as { projects: { environments: { placements: { server: { id: string } }[] }[] }[] };
    for (const p of projects.projects) for (const e of p.environments) for (const pl of e.placements) expect(pl.server.id).toBe(readOnly);
    const all = (await (await get("servers", mint({ name: "all" }).token)).json()) as { servers: unknown[] };
    expect(all.servers).toHaveLength(3);
  });

  it("keeps the dashboard's audit log from a token limited to some servers (403, audited), and gives it to an unlimited one", async () => {
    const limited = mint({ name: "limited", servers: [good] });
    const res = await get("audit", limited.token);
    expect(res.status).toBe(403);
    expect(store.recentAudit(5)[0]).toMatchObject({ event: "api_denied", actor: "token:limited" });
    expect((await get("audit", mint({ name: "everything" }).token)).status).toBe(200);
  });

  it("has no route that creates, lists or revokes a token, and no token management is reachable with a token", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(path.relative(path.join(process.cwd(), "app/api/v1"), full));
      }
    };
    walk(path.join(process.cwd(), "app/api/v1"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /token/i.test(f))).toEqual([]);
  });
});

describe("the shapes", () => {
  it("lists the servers with their state, and never a credential", async () => {
    const { token } = mint({ scope: "deploy" });
    const body = (await (await get("servers", token)).json()) as { servers: Record<string, unknown>[] };
    const byName = Object.fromEntries(body.servers.map((s) => [s.name, s]));
    expect(byName.prod).toEqual({ id: good, name: "prod", url: base, online: true, agent_version: "v1.2.3", update_available: false, can_deploy: true });
    expect(byName.dead).toMatchObject({ online: false, agent_version: null, can_deploy: true });
    expect(byName.readonly).toMatchObject({ online: true, can_deploy: false });
  });

  it("says can_deploy about the token: a read token deploys nowhere, even on a server that has a deploy secret", async () => {
    const { token } = mint({ scope: "read" });
    const list = (await (await get("servers", token)).json()) as { servers: { name: string; can_deploy: boolean }[] };
    expect(list.servers.map((s) => s.can_deploy)).toEqual(list.servers.map(() => false));
    const overview = (await (await get("servers/[id]/overview", token, { id: good })).json()) as { server: { can_deploy: boolean } };
    expect(overview.server.can_deploy).toBe(false);
    const projects = (await (await get("projects", token)).json()) as { projects: { environments: { placements: { server: { canDeploy: boolean } }[] }[] }[] };
    const flags = projects.projects.flatMap((p) => p.environments.flatMap((e) => e.placements.map((pl) => pl.server.canDeploy)));
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f === false)).toBe(true);
  });

  it("gives the data behind the server page as an overview, without the containers' command lines", async () => {
    const { token } = mint();
    const body = (await (await get("servers/[id]/overview", token, { id: good })).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["apps", "containers", "health", "server"]);
    expect(body.server).toMatchObject({ id: good, name: "prod", online: true });
    expect(body.health).toMatchObject({ info: { version: "v1.2.3" }, system: { host: { cpus: 2 } } });
    expect((body.apps as { name: string }[]).map((a) => a.name)).toEqual(["shop"]);
    const containers = body.containers as Record<string, unknown>[];
    expect(containers[0]).toMatchObject({ name: "shop", state: "running" });
    expect(containers[0]).not.toHaveProperty("command");
  });

  it("says nothing of an app's managed environment variables, not even when they last changed", async () => {
    const { token } = mint();
    for (const [file, params] of [["servers/[id]/apps", { id: good }], ["servers/[id]/overview", { id: good }], ["projects", {}]] as const) {
      const text = await (await get(file, token, params)).text();
      expect(text, file).toContain('"shop"');
      expect(text, file).not.toContain("env_changed_at");
      expect(text, file).not.toContain("2026-01-01T12:00:00Z");
    }
  });

  it("derives the state of a database's backup", async () => {
    const { token } = mint();
    const body = (await (await get("servers/[id]/databases", token, { id: good })).json()) as { databases: { name: string; backup_state: string; has_password: boolean }[] };
    expect(body.databases[0]).toMatchObject({ name: "main", backup_state: "ok", has_password: true });
    overrides.set("GET /v1/databases", () => ({ status: 200, body: [{ name: "m", host: "h", port: 1, database: "d", user: "u", has_password: false, backup: { ...BACKUP, paused: true } }, { name: "n", backup: null }] }));
    const states = ((await (await get("servers/[id]/databases", token, { id: good })).json()) as { databases: { backup_state: string }[] }).databases.map((d) => d.backup_state);
    expect(states).toEqual(["paused", "no_backup"]);
  });

  it("answers empty lists, not errors, for an agent without deployments", async () => {
    const { token } = mint();
    for (const [key, file] of [["apps", "apps"], ["previews", "previews"], ["jobs", "jobs"], ["databases", "databases"]] as const) {
      overrides.set(`GET /v1/${key}`, () => ({ status: 404, body: { error: "not found" } }));
      const res = await get(`servers/[id]/${file}`, token, { id: good });
      expect(res.status, file).toBe(200);
      expect(await res.json()).toEqual({ [key]: [] });
    }
    overrides.set("GET /v1/proxy", () => ({ status: 404, body: { error: "not found" } }));
    expect(await (await get("servers/[id]/proxy", token, { id: good })).json()).toEqual({ proxy: null });
  });

  it("groups the projects across servers", async () => {
    const { token } = mint();
    const body = (await (await get("projects", token)).json()) as { projects: { name: string; environments: { name: string }[] }[]; unreachable: { name: string }[]; read_only: unknown[] };
    expect(body.projects.map((p) => p.name)).toEqual(["shop"]);
    expect(body.projects[0].environments.map((e) => e.name)).toEqual(["production"]);
    expect(body.unreachable.map((s) => s.name)).toEqual(["dead"]);
  });

  it("lists the dashboard's audit entries with their actor, newest first, at most 200", async () => {
    const { token } = mint();
    store.audit("login", "password", "1.1.1.1");
    store.audit("api_deploy", "server=prod", "2.2.2.2", "token:ci");
    const body = (await (await get("audit", token, {}, "?limit=1")).json()) as { entries: { event: string; actor: string | null; at: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ event: "api_deploy", actor: "token:ci" });
    expect(Number.isNaN(Date.parse(body.entries[0].at))).toBe(false);
    expect((await get("audit", token, {}, "?limit=201")).status).toBe(400);
    expect((await get("audit", token, {}, "?limit=0")).status).toBe(400);
  });

  it("passes the limits to the agent, with defaults, and refuses what is out of bounds", async () => {
    const { token } = mint();
    await get("servers/[id]/deployments", token, { id: good });
    await get("servers/[id]/deployments", token, { id: good }, "?app=shop&limit=100");
    expect(seen.filter((s) => s.url.startsWith("/v1/deployments")).map((s) => s.url)).toEqual(["/v1/deployments?limit=20", "/v1/deployments?limit=100&app=shop"]);
    for (const q of ["?limit=101", "?limit=0", "?limit=abc", "?limit=-1", "?app=a/b"]) expect((await get("servers/[id]/deployments", token, { id: good }, q)).status, q).toBe(400);
    expect((await get("servers/[id]/jobs/[name]/runs", token, { id: good, name: "nightly" }, "?limit=101")).status).toBe(400);
    seen.length = 0;
    await get("servers/[id]/jobs/[name]/runs", token, { id: good, name: "nightly" }, "?limit=5");
    expect(seen[0].url).toBe("/v1/jobs/nightly/runs?limit=5");
  });

  it("cuts a job run's output", async () => {
    const { token } = mint();
    const body = (await (await get("servers/[id]/jobs/[name]/runs", token, { id: good, name: "nightly" })).json()) as { runs: { output: string }[] };
    expect(body.runs[0].output.length).toBeLessThan(17_000);
    expect(body.runs[0].output).toContain("[output cut");
  });
});

describe("logs", () => {
  const logEvents = (n: number, size = 20): [string, unknown][] => [
    ...Array.from({ length: n }, (_, i): [string, unknown] => ["log", { time: `t${i}`, stream: "stdout", line: `line ${i} ${"x".repeat(size)}\n` }]),
    ["end", {}],
  ];

  it("returns plain text lines, asking the agent for 200 by default and never following", async () => {
    sseBody = sse(logEvents(3));
    overrides.set("GET /v1/containers/shop/logs", () => "sse");
    const { token } = mint();
    const res = await get("servers/[id]/containers/[name]/logs", token, { id: good, name: "shop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[]; truncated: boolean };
    expect(body.lines).toHaveLength(3);
    expect(body.lines[0]).toBe(`t0 line 0 ${"x".repeat(20)}`);
    expect(body.truncated).toBe(false);
    expect(seen.at(-1)?.url).toBe("/v1/containers/shop/logs?tail=200");
  });

  it("keeps the newest lines within 256 KiB and says it cut", async () => {
    sseBody = sse(logEvents(1000, 1000));
    overrides.set("GET /v1/containers/shop/logs", () => "sse");
    const { token } = mint();
    const body = (await (await get("servers/[id]/containers/[name]/logs", token, { id: good, name: "shop" }, "?tail=1000")).json()) as { lines: string[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.lines.join("\n"))).toBeLessThanOrEqual(LOG_BYTES_MAX);
    expect(body.lines.length).toBeGreaterThan(100);
    expect(body.lines.at(-1)).toContain("line 999 ");
    expect(seen.at(-1)?.url).toBe("/v1/containers/shop/logs?tail=1000");
  });

  it("cuts one huge line, and never returns more lines than were asked for", async () => {
    sseBody = sse([...logEvents(5), ...[]].slice(0, 5).concat([["log", { time: "t", stream: "stdout", line: "y".repeat(20_000) }], ["end", {}]]));
    overrides.set("GET /v1/containers/shop/logs", () => "sse");
    const { token } = mint();
    const body = (await (await get("servers/[id]/containers/[name]/logs", token, { id: good, name: "shop" }, "?tail=3")).json()) as { lines: string[]; truncated: boolean };
    expect(body.lines).toHaveLength(3);
    expect(body.lines.at(-1)!.length).toBeLessThan(9000);
    expect(body.truncated).toBe(true);
  });

  it("refuses a tail above 1000, below 1 or not a number", async () => {
    const { token } = mint();
    for (const q of ["?tail=1001", "?tail=0", "?tail=all", "?tail=-5", "?tail=1e3"]) expect((await get("servers/[id]/containers/[name]/logs", token, { id: good, name: "shop" }, q)).status, q).toBe(400);
  });

  it("passes an unknown container through as a 404", async () => {
    overrides.set("GET /v1/containers/nope/logs", () => ({ status: 404, body: { error: "no such container" } }));
    const res = await get("servers/[id]/containers/[name]/logs", mint().token, { id: good, name: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such container" });
  });
});

describe("a deployment with its events", () => {
  const events = (n: number): [string, unknown][] => [
    ...Array.from({ length: n }, (_, i): [string, unknown] => ["event", { seq: i + 1, time: "t", level: "info", message: `step ${i + 1}` }]),
    ["end", { status: "succeeded" }],
  ];

  it("adds the events of the deployment", async () => {
    sseBody = sse(events(3));
    overrides.set("GET /v1/deployments/dep1/events", () => "sse");
    const body = (await (await get("servers/[id]/deployments/[deployment]", mint().token, { id: good, deployment: "dep1" })).json()) as { id: string; events: { seq: number }[] };
    expect(body.id).toBe("dep1");
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps the last 500", async () => {
    sseBody = sse(events(600));
    overrides.set("GET /v1/deployments/dep1/events", () => "sse");
    const body = (await (await get("servers/[id]/deployments/[deployment]", mint().token, { id: good, deployment: "dep1" })).json()) as { events: { seq: number }[] };
    expect(body.events).toHaveLength(500);
    expect(body.events[0].seq).toBe(101);
    expect(body.events.at(-1)?.seq).toBe(600);
  });

  it("returns what a running deployment has so far instead of waiting for its end", async () => {
    sseBody = sse(events(2).slice(0, 2));
    overrides.set("GET /v1/deployments/dep1", () => ({ status: 200, body: { ...DEPLOYMENT, status: "running" } }));
    overrides.set("GET /v1/deployments/dep1/events", () => "sse");
    const started = Date.now();
    const body = (await (await get("servers/[id]/deployments/[deployment]", mint().token, { id: good, deployment: "dep1" })).json()) as { status: string; events: unknown[] };
    expect(body.status).toBe("running");
    expect(body.events).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("passes an unknown deployment through as a 404", async () => {
    overrides.set("GET /v1/deployments/zzz", () => ({ status: 404, body: { error: "deployment not found" } }));
    const res = await get("servers/[id]/deployments/[deployment]", mint().token, { id: good, deployment: "zzz" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "deployment not found" });
  });
});

describe("an agent that cannot be reached", () => {
  it("is a 502 with the reason, for every read about it", async () => {
    const { token } = mint();
    for (const r of READS().filter((x) => x.params.id !== undefined)) {
      const res = await get(r.file, token, { ...r.params, id: dead });
      expect(res.status, r.file).toBe(502);
      expect(((await res.json()) as { error: string }).error, r.file).toMatch(/^agent unreachable: connection refused/);
    }
  });
});

describe("the writes", () => {
  it("asks for a deployment with the signed request the dashboard's own button sends, as the token, and audits it", async () => {
    const { token } = mint({ name: "pipeline", scope: "deploy" });
    const res = await post("servers/[id]/apps/[app]/deploy", token, { id: good, app: "shop" }, { tag: "v1.2.3" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deployment_id: "dep2" });
    const sent = seen.find((s) => s.method === "POST")!;
    expect(sent.url).toBe("/v1/apps/shop/deploy");
    expect(sent.body).toBe('{"tag":"v1.2.3"}');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-keelson-actor"]).toBe("token:pipeline");
    const ts = Number(sent.headers["x-keelson-timestamp"]);
    expect(sent.headers["x-keelson-signature"]).toBe(sign(DEPLOY_SECRET, ts, "POST", "/v1/apps/shop/deploy", sent.body));
    const line = store.recentAudit(5)[0];
    expect(line).toMatchObject({ event: "api_deploy", actor: "token:pipeline", ip: "local" });
    expect(line.detail).toBe("server=prod app=shop ref=v1.2.3 outcome=accepted deployment_id=dep2");
  });

  it("deploys by digest, and refuses a body that is not exactly one valid tag or digest, with an audit line", async () => {
    const { token } = mint({ scope: "deploy" });
    const digest = "sha256:" + "a".repeat(64);
    expect((await post("servers/[id]/apps/[app]/deploy", token, { id: good, app: "shop" }, { digest })).status).toBe(202);
    expect(seen.find((s) => s.method === "POST")?.body).toBe(JSON.stringify({ digest }));
    seen.length = 0;
    const bad: [unknown, string?][] = [
      [{}],
      [{ tag: "v1", digest }],
      [{ tag: 5 }],
      [{ tag: "has space" }],
      [{ tag: digest }],
      [{ digest: "v1" }],
      [{ digest: "sha256:abc" }],
      [null],
      [undefined, "not json"],
      [undefined, "x".repeat(5000)],
    ];
    for (const [body, raw] of bad) {
      const res = await post("servers/[id]/apps/[app]/deploy", token, { id: good, app: "shop" }, body, raw);
      expect(res.status, JSON.stringify(body) ?? raw).toBe(400);
    }
    expect(seen).toEqual([]);
    expect(store.recentAudit(20).filter((e) => e.event === "api_deploy" && e.detail?.includes("outcome=rejected")).length).toBe(bad.length);
  });

  it("rolls back and runs a job, auditing both", async () => {
    const { token } = mint({ name: "ops", scope: "deploy" });
    const rolled = await post("servers/[id]/apps/[app]/rollback", token, { id: good, app: "shop" });
    expect([rolled.status, await rolled.json()]).toEqual([202, { deployment_id: "dep3" }]);
    const ran = await post("servers/[id]/jobs/[name]/run", token, { id: good, name: "nightly" });
    expect([ran.status, await ran.json()]).toEqual([202, { run_id: "run2" }]);
    expect(seen.filter((s) => s.method === "POST").map((s) => [s.url, s.headers["x-keelson-actor"]])).toEqual([
      ["/v1/apps/shop/rollback", "token:ops"],
      ["/v1/jobs/nightly/run", "token:ops"],
    ]);
    expect(store.recentAudit(5).map((e) => [e.event, e.actor, e.detail])).toEqual([
      ["api_job_run", "token:ops", "server=prod job=nightly outcome=accepted run_id=run2"],
      ["api_rollback", "token:ops", "server=prod app=shop outcome=accepted deployment_id=dep3"],
    ]);
  });

  it("passes the agent's refusals through with its message, and audits them", async () => {
    const { token } = mint({ scope: "deploy" });
    overrides.set("POST /v1/apps/shop/deploy", () => ({ status: 409, body: { error: "a deployment of shop is already running" } }));
    overrides.set("POST /v1/apps/ghost/deploy", () => ({ status: 404, body: { error: "unknown app ghost" } }));
    const busy = await post("servers/[id]/apps/[app]/deploy", token, { id: good, app: "shop" }, { tag: "v2" });
    expect([busy.status, await busy.json()]).toEqual([409, { error: "a deployment of shop is already running" }]);
    const unknown = await post("servers/[id]/apps/[app]/deploy", token, { id: good, app: "ghost" }, { tag: "v2" });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "unknown app ghost" }]);
    const details = store.recentAudit(5).map((e) => e.detail);
    expect(details).toEqual(["server=prod app=ghost ref=v2 outcome=refused (404): unknown app ghost", "server=prod app=shop ref=v2 outcome=refused (409): a deployment of shop is already running"]);
  });

  it("answers 502 for an agent that cannot be reached, and audits that too", async () => {
    const { token } = mint({ scope: "deploy" });
    const res = await post("servers/[id]/apps/[app]/rollback", token, { id: dead, app: "shop" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/^agent unreachable: /);
    expect(store.recentAudit(1)[0].detail).toMatch(/^server=dead app=shop outcome=unreachable: /);
  });

  it("refuses a server that has no deploy secret before asking the agent", async () => {
    const { token } = mint({ scope: "deploy" });
    const res = await post("servers/[id]/apps/[app]/deploy", token, { id: readOnly, app: "shop" }, { tag: "v1" });
    expect(res.status).toBe(409);
    expect(seen).toEqual([]);
    expect(store.recentAudit(1)[0].detail).toBe("server=readonly app=shop ref=v1 outcome=refused: the server has no deploy secret");
  });

  it("sends an actor the agent can carry in a header whatever the token is called", async () => {
    const { token } = mint({ name: "Café ☕ build", scope: "deploy" });
    expect((await post("servers/[id]/apps/[app]/rollback", token, { id: good, app: "shop" })).status).toBe(202);
    expect(seen.find((s) => s.method === "POST")?.headers["x-keelson-actor"]).toBe("token:Caf? ? build");
    expect(store.recentAudit(1)[0].actor).toBe("token:Café ☕ build");
  });
});

describe("secrets", () => {
  it("appear in no response of any endpoint, for a server that holds all of them", async () => {
    const reader = mint({ name: "reader" });
    const deployer = mint({ name: "deployer", scope: "deploy" });
    overrides.set("GET /v1/containers/shop/logs", () => "sse");
    sseBody = sse([["log", { time: "t", stream: "stdout", line: "hello\n" }], ["end", {}]]);
    overrides.set("GET /v1/deployments/dep1/events", () => "sse");

    const dumped: string[] = [];
    for (const r of READS()) dumped.push(await (await get(r.file, reader.token, r.params, r.query)).text());
    for (const w of WRITES()) dumped.push(await (await post(w.file, deployer.token, w.params, w.body)).text());
    // Errors too: a refusal and an unreachable agent.
    dumped.push(await (await post(WRITES()[0].file, reader.token, WRITES()[0].params, WRITES()[0].body)).text());
    dumped.push(await (await get("servers/[id]/overview", reader.token, { id: dead })).text());
    dumped.push(await (await get("servers", null)).text());
    dumped.push(await (await get("audit", reader.token)).text());
    const everything = dumped.join("\n");

    expect(everything.length).toBeGreaterThan(1000);
    const secrets = [
      AGENT_TOKEN,
      DEPLOY_SECRET,
      "CLIENT-KEY-MATERIAL",
      "CA-CERT-MATERIAL",
      "CLIENT-CERT-MATERIAL",
      "hunter2",
      process.env.KEELSON_DASHBOARD_KEY!,
      process.env.KEELSON_ADMIN_PASSWORD_HASH!,
      reader.token,
      deployer.token,
      tokens.getApiToken(reader.record.id) && (await import("@/lib/api-tokens-core")).hashToken(reader.token),
      "token_enc",
      "deploy_secret",
      "client_key",
    ];
    for (const secret of secrets) expect(everything, String(secret).slice(0, 12)).not.toContain(secret as string);
    // The audit log the API serves holds the token's name, never its secret or hash.
    const audit = JSON.stringify(store.recentAudit(100));
    expect(audit).not.toContain(reader.token);
  });
});
