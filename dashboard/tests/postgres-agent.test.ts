import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_TOO_OLD_FOR_POSTGRES, AgentClient, AgentError, type AgentConnection } from "@/lib/agent";
import { sign } from "@/lib/sign";

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
let respond: (req: Seen) => { status: number; body: unknown } | { status: number; text: string } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      const out = respond(entry);
      if ("text" in out) {
        res.writeHead(out.status, { "Content-Type": "text/plain" });
        res.end(out.text);
      } else {
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function client(over: Partial<AgentConnection> = {}) {
  const conn: AgentConnection = { url: base, token: TOKEN, deploySecret: SECRET, caCert: null, clientCert: null, clientKey: null, ...over };
  return new AgentClient(conn, new Agent());
}

const STATUS = {
  exists: true, state: "running", running: true, health: "healthy", container: "keelson-postgres", image: "postgres:16-alpine", major: 16,
  server_version: "16.15", size_bytes: 7_500_000, volume: "keelson-postgres-data", network: "keelson", host: "keelson-postgres", port: 5442,
  memory_bytes: 536_870_912, settings_current: true, databases: [{ name: "shop", app: "shop", env_key: "DATABASE_URL" }],
};

describe("agent client: managed PostgreSQL", () => {
  it("reads the instance with the bearer token", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: STATUS });
    expect(await client().postgres()).toEqual(STATUS);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/postgres" });
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null for an agent that has no such route, and passes every other failure on", async () => {
    respond = () => ({ status: 404, text: "404 page not found\n" });
    expect(await client().postgres()).toBeNull();
    respond = () => ({ status: 500, body: { error: "boom" } });
    await expect(client().postgres()).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("signs a create over the exact body, never sends the bearer token, and hands the backup key back once", async () => {
    seen.length = 0;
    const result = {
      database: { name: "shop", app: "shop", database: "shop", user: "shop", host: "keelson-postgres", port: 5432, mode: "network" },
      env_key: "DATABASE_URL", created: true, redeploy_required: true,
      backup_key: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ", backup_recipient: "age1abc",
    };
    respond = () => ({ status: 200, body: result });
    expect(await client().createDatabase({ app: "shop", name: "shop", backup: { keep: 5 } })).toEqual(result);
    const r = seen[0];
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/postgres/databases");
    expect(JSON.parse(r.body)).toEqual({ app: "shop", name: "shop", backup: { keep: 5 } });
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, Number(r.headers["x-keelson-timestamp"]), "POST", "/v1/postgres/databases", r.body));
  });

  it("drops with the confirmation in the body and rotates without one, both signed", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { name: "shop", dropped: true } });
    await client().dropDatabase("my shop", "my shop");
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/v1/postgres/databases/my%20shop" });
    expect(JSON.parse(seen[0].body)).toEqual({ confirm: "my shop" });
    expect(seen[0].headers["x-keelson-signature"]).toBeTruthy();
    respond = () => ({ status: 200, body: { database: {}, env_key: "DATABASE_URL", created: false, redeploy_required: true } });
    expect((await client().rotateDatabasePassword("shop")).redeploy_required).toBe(true);
    expect(seen[1]).toMatchObject({ method: "POST", url: "/v1/postgres/databases/shop/password" });
    expect(seen[1].headers["x-keelson-signature"]).toBeTruthy();
  });

  it("says an agent without the route is too old, but keeps the agent's own 404 (an unknown app or database)", async () => {
    respond = () => ({ status: 404, text: "404 page not found\n" });
    await expect(client().createDatabase({ app: "shop" })).rejects.toMatchObject({ status: 404, message: AGENT_TOO_OLD_FOR_POSTGRES });
    respond = () => ({ status: 404, body: { error: "no such app" } });
    const err = await client().createDatabase({ app: "ghost" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ status: 404, message: "no such app" });
  });

  it("passes the agent's refusals on with their status and message", async () => {
    for (const [status, message] of [[400, "name must match the pattern"], [409, "database shop belongs to app other"], [502, "the managed PostgreSQL could not be brought up: the image could not be pulled"]] as const) {
      respond = () => ({ status, body: { error: message } });
      await expect(client().createDatabase({ app: "shop" })).rejects.toMatchObject({ status, message });
    }
  });
});
