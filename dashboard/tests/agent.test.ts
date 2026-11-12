import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient, AgentError, probeAgent, type AgentConnection } from "@/lib/agent";
import { sign } from "@/lib/sign";
import { Agent } from "undici";

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (req: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      const { status, body: out } = respond(entry);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** A localhost URL that nothing listens on (port 1 would be refused by fetch's bad-port list). */
async function closedUrl(): Promise<string> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function client(over: Partial<AgentConnection> = {}) {
  const conn: AgentConnection = { url: base, token: TOKEN, deploySecret: SECRET, caCert: null, clientCert: null, clientKey: null, ...over };
  return new AgentClient(conn, new Agent());
}

describe("agent client", () => {
  it("reads with the bearer token", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: [{ name: "web" }] });
    await client().containers(false);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1/containers?all=false");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("signs deployments with the deploy secret and never sends the bearer token with them", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { deployment_id: "abc123" } });
    const id = await client().deploy("web", { tag: "v1.2.3" });

    expect(id).toBe("abc123");
    const r = seen[0];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/apps/web/deploy");
    expect(r.body).toBe('{"tag":"v1.2.3"}');
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(5);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/apps/web/deploy", r.body));
  });

  it("signs rollbacks over an empty body", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { deployment_id: "r1" } });
    await client().rollback("web");
    const ts = Number(seen[0].headers["x-keelson-timestamp"]);
    expect(seen[0].headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/apps/web/rollback", ""));
  });

  it("refuses to deploy without a deploy secret, before any request", async () => {
    seen.length = 0;
    await expect(client({ deploySecret: null }).deploy("web", { tag: "v1" })).rejects.toThrow(/no deploy secret/);
    expect(seen).toHaveLength(0);
  });

  it("escapes path segments", async () => {
    seen.length = 0;
    respond = () => ({ status: 404, body: { error: "container not found" } });
    await client().container("../../etc").catch(() => {});
    expect(seen[0].url).toBe("/v1/containers/..%2F..%2Fetc");
  });

  it("turns the agent's error answers into AgentError with its message", async () => {
    respond = () => ({ status: 409, body: { error: "a deployment is already running for this app" } });
    const err = await client().deploy("web", { tag: "v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ status: 409, message: "a deployment is already running for this app" });

    respond = () => ({ status: 500, body: "not json" });
    await expect(client().info()).rejects.toMatchObject({ status: 500, message: "the agent answered 500" });
  });

  it("reports apps as null when the agent has no deployments", async () => {
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().apps()).toBeNull();
    respond = () => ({ status: 401, body: { error: "unauthorized" } });
    await expect(client().apps()).rejects.toMatchObject({ status: 401 });
  });

  it("tells an agent older than the health and proxy views from a failing one", async () => {
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().system()).toBeNull();
    expect(await client().diskUsage()).toBeNull();
    expect(await client().proxy()).toBeNull();
    respond = () => ({ status: 502, body: { error: "docker engine error" } });
    await expect(client().diskUsage()).rejects.toMatchObject({ status: 502, message: "docker engine error" });
  });

  it("reads the recorded history with an escaped container name and tells an agent that records none", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { container: "web-1", step_seconds: 30, points: [] } });
    await client().statsHistory("web 1", "6h");
    expect(seen[0].url).toBe("/v1/stats/history?container=web%201&range=6h");
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().statsHistory("web", "1h")).toBeNull();
    respond = () => ({ status: 400, body: { error: "range must be a duration between 1m and 24h, such as 6h" } });
    await expect(client().statsHistory("web", "1h")).rejects.toMatchObject({ status: 400 });
  });

  it("explains an unreachable agent", async () => {
    const err = await client({ url: await closedUrl() }).info().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, message: "cannot reach the agent: connection refused" });
  });

  it("checks health without credentials and survives failures", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { status: "ok" } });
    expect(await client().healthy()).toBe(true);
    expect(seen[0].headers.authorization).toBeUndefined();
    respond = () => ({ status: 503, body: { status: "degraded" } });
    expect(await client().healthy()).toBe(false);
    expect(await client({ url: await closedUrl() }).healthy()).toBe(false);
  });

  it("probes a server before it is saved", async () => {
    respond = () => ({ status: 200, body: [] });
    await expect(probeAgent({ url: base, token: TOKEN, deploySecret: null, caCert: null, clientCert: null, clientKey: null })).resolves.toBeUndefined();
    respond = () => ({ status: 401, body: { error: "unauthorized" } });
    await expect(probeAgent({ url: base, token: "wrong", deploySecret: null, caCert: null, clientCert: null, clientKey: null })).rejects.toMatchObject({ status: 401 });
  });
});

describe("agent client: jobs", () => {
  it("reports jobs as null when the agent has none configured", async () => {
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().jobs()).toBeNull();
    respond = () => ({ status: 200, body: [{ name: "backup", kind: "host" }] });
    expect(await client().jobs()).toEqual([{ name: "backup", kind: "host" }]);
  });

  it("reads a job's runs with the bearer token and an escaped name", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: [] });
    await client().jobRuns("daily report", 5);
    expect(seen[0].url).toBe("/v1/jobs/daily%20report/runs?limit=5");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("runs a job with a signed, bodyless POST", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { run_id: "abc" } });
    expect(await client().runJob("backup")).toBe("abc");
    const r = seen[0];
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.method).toBe("POST");
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/jobs/backup/run", ""));
  });
});

describe("agent client: databases", () => {
  it("reports databases as null when the agent has no apps file", async () => {
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().databases()).toBeNull();
    respond = () => ({ status: 200, body: [{ name: "shop" }] });
    expect(await client().databases()).toEqual([{ name: "shop" }]);
  });

  it("keeps the agent's message when the server cannot be probed", async () => {
    respond = () => ({ status: 502, body: { error: "connection refused" } });
    await expect(client().databaseLive("shop")).rejects.toMatchObject({ status: 502, message: "connection refused" });
  });

  it("signs a restore over its JSON body", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { run_id: "r1" } });
    const body = { backup: "shop/shop-20260101T030000Z.dump.age", identity: "AGE-SECRET-KEY-1X", target: "shop_restore_20260101" };
    expect(await client().restoreDatabase("shop", body)).toBe("r1");
    const r = seen[0];
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers.authorization).toBeUndefined();
    expect(JSON.parse(r.body)).toEqual(body);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/databases/shop/restore", r.body));
  });

  it("wraps a configuration in the request the agent expects", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { hash: "h2" } });
    const database = { name: "shop", host: "127.0.0.1", database: "shop", user: "shop" };
    await client().saveDatabase("shop", database, { base_hash: "h1" });
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe("/v1/config/databases/shop");
    expect(JSON.parse(seen[0].body)).toEqual({ database, base_hash: "h1" });
  });
});

describe("agent client: previews", () => {
  it("lists the previews with the bearer token and reports null for an agent without them", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { previews: [{ name: "shop-pr-12", app: "shop", pr: 12 }] } });
    expect(await client().previews()).toEqual([{ name: "shop-pr-12", app: "shop", pr: 12 }]);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1/previews");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);

    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().previews()).toBeNull();
    respond = () => ({ status: 500, body: { error: "boom" } });
    await expect(client().previews()).rejects.toMatchObject({ status: 500 });
  });

  it("creates or redeploys a preview with a signed PUT of only the tag, and never sends the bearer token", async () => {
    seen.length = 0;
    const sha = "a".repeat(40);
    respond = () => ({ status: 202, body: { deployment_id: "d1", name: "shop-pr-12", url: "https://pr-12-shop.example.com", evicted: ["shop-pr-3"] } });
    expect(await client().deployPreview("shop", 12, sha)).toEqual({ deployment_id: "d1", name: "shop-pr-12", url: "https://pr-12-shop.example.com", evicted: ["shop-pr-3"] });
    const r = seen[0];
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("/v1/previews/shop/12");
    expect(r.body).toBe(`{"tag":"${sha}"}`);
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "PUT", "/v1/previews/shop/12", r.body));
  });

  it("removes a preview with a signed bodyless DELETE, accepting 204, and escapes the app", async () => {
    seen.length = 0;
    respond = () => ({ status: 204, body: null });
    await client().deletePreview("sh/op", 7);
    const r = seen[0];
    expect(r.method).toBe("DELETE");
    expect(r.url).toBe("/v1/previews/sh%2Fop/7");
    expect(r.body).toBe("");
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "DELETE", "/v1/previews/sh%2Fop/7", ""));
  });

  it("keeps the agent's refusals as AgentError, and needs the deploy secret before any request", async () => {
    respond = () => ({ status: 409, body: { error: "a deployment of this preview is running" } });
    await expect(client().deployPreview("shop", 1, "a".repeat(40))).rejects.toMatchObject({ status: 409, message: "a deployment of this preview is running" });
    await expect(client().deletePreview("shop", 1)).rejects.toMatchObject({ status: 409 });
    seen.length = 0;
    await expect(client({ deploySecret: null }).deletePreview("shop", 1)).rejects.toThrow(/no deploy secret/);
    await expect(client({ deploySecret: null }).deployPreview("shop", 1, "a".repeat(40))).rejects.toThrow(/no deploy secret/);
    expect(seen).toHaveLength(0);
  });
});

describe("agent client: builds", () => {
  const sha = "a".repeat(40);
  const source = { url: `https://api.github.com/repos/acme/shop/tarball/${sha}`, token: "ghs_installation_token" };

  it("asks for a build with a signed POST of the commit, the source and deploy, and never sends the bearer token", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { deployment_id: "b1" } });
    expect(await client().build("sh/op", sha, source)).toBe("b1");
    const r = seen[0];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/apps/sh%2Fop/build");
    expect(JSON.parse(r.body)).toEqual({ sha, source, deploy: true });
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/apps/sh%2Fop/build", r.body));
  });

  it("asks for a preview build with a signed PUT of the commit and the source instead of a tag", async () => {
    seen.length = 0;
    respond = () => ({ status: 202, body: { deployment_id: "b2", name: "shop-pr-12", url: "https://pr-12-shop.example.com", evicted: [] } });
    expect(await client().buildPreview("shop", 12, sha, source)).toMatchObject({ deployment_id: "b2" });
    const r = seen[0];
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("/v1/previews/shop/12");
    expect(JSON.parse(r.body)).toEqual({ sha, source });
    expect(JSON.parse(r.body)).not.toHaveProperty("tag");
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "PUT", "/v1/previews/shop/12", r.body));
  });

  it("keeps the agent's refusals, with the source token taken out of the message", async () => {
    respond = () => ({ status: 400, body: { error: "app shop has no build: block" } });
    await expect(client().build("shop", sha, source)).rejects.toMatchObject({ status: 400, message: "app shop has no build: block" });
    respond = () => ({ status: 400, body: { error: `bad source ${source.token} given` } });
    const err = await client().build("shop", sha, source).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toBe("bad source [redacted] given");
    expect(JSON.stringify(err)).not.toContain(source.token);
    respond = () => ({ status: 409, body: { error: "busy" } });
    await expect(client().buildPreview("shop", 1, sha, source)).rejects.toMatchObject({ status: 409 });
    seen.length = 0;
    await expect(client({ deploySecret: null }).build("shop", sha, source)).rejects.toThrow(/no deploy secret/);
    expect(seen).toHaveLength(0);
  });

  it("asks another server to build with a signed POST of the request, and names no app of its own", async () => {
    seen.length = 0;
    const request = { app: "shop", image: "keelson-local/shop", sha, source, build: { preset: "node" as const, memory: "1g" }, port: 3000 };
    respond = () => ({ status: 202, body: { deployment_id: "b3" } });
    expect(await client().startBuild(request)).toBe("b3");
    const r = seen[0];
    expect([r.method, r.url]).toEqual(["POST", "/v1/builds"]);
    expect(JSON.parse(r.body)).toEqual(request);
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/builds", r.body));
  });

  it("keeps the builder's refusal of a request, with the source token taken out of the message", async () => {
    const request = { app: "shop", image: "keelson-local/shop", sha, source, build: { memory: "9g" } };
    respond = () => ({ status: 400, body: { error: "build.memory 9g is above this server's build_limits.memory (1g)" } });
    await expect(client().startBuild(request)).rejects.toMatchObject({ status: 400, message: "build.memory 9g is above this server's build_limits.memory (1g)" });
    respond = () => ({ status: 409, body: { error: `an app named shop already runs ${source.token}` } });
    const err = await client().startBuild(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, message: "an app named shop already runs [redacted]" });
  });

  it("asks for an image by its repository and tag, without an app", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: {} });
    await client().exportImageByRef({ image: "keelson-local/shop", tag: sha });
    const r = seen[0];
    expect([r.method, r.url]).toEqual(["POST", "/v1/images/export"]);
    expect(JSON.parse(r.body)).toEqual({ image: "keelson-local/shop", tag: sha });
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/images/export", r.body));
  });
});

describe("container start and restart", () => {
  it("signs a POST over an empty body for the container's route", async () => {
    seen.length = 0;
    respond = () => ({ status: 204, body: {} });
    await client().containerAction("my web", "restart");
    const r = seen[0];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/containers/my%20web/restart");
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "POST", "/v1/containers/my%20web/restart", ""));
  });

  it("tells an agent without the routes (plain 404) from an unknown container (JSON 404)", async () => {
    respond = () => ({ status: 404, body: "404 page not found" });
    await expect(client().containerAction("web", "start")).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/too old/) });
    respond = () => ({ status: 404, body: { error: "container not found" } });
    await expect(client().containerAction("web", "start")).rejects.toMatchObject({ status: 404, message: "container not found" });
  });

  it("passes on a refusal for an unmanaged container", async () => {
    respond = () => ({ status: 409, body: { error: "not managed by keelson" } });
    await expect(client().containerAction("db", "restart")).rejects.toMatchObject({ status: 409, message: "not managed by keelson" });
  });

  it("refuses without a deploy secret before any request", async () => {
    seen.length = 0;
    await expect(client({ deploySecret: null }).containerAction("web", "start")).rejects.toThrow(/no deploy secret/);
    expect(seen).toHaveLength(0);
  });
});

/** Starts a server on a free loopback port and says where it is. */
async function listen(server: Server): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

describe("an agent that redirects", () => {
  let elsewhere: Server;
  let redirecting: Server;
  let redirectingUrl = "";
  const hit: string[] = [];

  beforeAll(async () => {
    elsewhere = createServer((req, res) => {
      hit.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const elsewhereUrl = await listen(elsewhere);
    redirecting = createServer((_req, res) => {
      res.writeHead(302, { Location: `${elsewhereUrl}/internal` });
      res.end();
    });
    redirectingUrl = await listen(redirecting);
  });
  afterAll(async () => {
    await close(elsewhere);
    await close(redirecting);
  });

  const against = () => new AgentClient({ url: redirectingUrl, token: TOKEN, deploySecret: SECRET, caCert: null, clientCert: null, clientKey: null }, new Agent());

  it("is an error, and the address it points to is never requested (no bouncing of requests to other hosts)", async () => {
    hit.length = 0;
    await expect(against().containers(false)).rejects.toBeInstanceOf(AgentError);
    expect(hit).toEqual([]);
  });

  it("is not healthy, and nothing is requested elsewhere either", async () => {
    hit.length = 0;
    expect(await against().healthy()).toBe(false);
    expect(hit).toEqual([]);
  });
});
