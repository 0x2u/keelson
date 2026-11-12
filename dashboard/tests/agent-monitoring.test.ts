import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient, type AgentConnection } from "@/lib/agent";
import { Agent } from "undici";

const TOKEN = "t".repeat(40);

let server: Server;
let base: string;
const urls: string[] = [];
let respond: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    urls.push(req.url ?? "");
    const { status, body } = respond();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function client() {
  const conn: AgentConnection = { url: base, token: TOKEN, deploySecret: null, caCert: null, clientCert: null, clientKey: null };
  return new AgentClient(conn, new Agent());
}

describe("agent client: host history and availability", () => {
  it("reads the host history, and tells an agent that records none from one that failed", async () => {
    urls.length = 0;
    respond = () => ({ status: 200, body: { cpus: 2, step_seconds: 30, points: [] } });
    expect(await client().hostHistory("6h")).toMatchObject({ cpus: 2, points: [] });
    expect(urls[0]).toBe("/v1/stats/host?range=6h");
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().hostHistory("1h")).toBeNull();
    respond = () => ({ status: 500, body: { error: "boom" } });
    await expect(client().hostHistory("1h")).rejects.toMatchObject({ status: 500 });
  });

  it("reads an app's availability with its name escaped, null on an agent without the route", async () => {
    urls.length = 0;
    respond = () => ({ status: 200, body: { app: "we b", range: "7d", since: null, uptime_percent: null, incidents: [] } });
    expect(await client().availability("we b", "7d")).toMatchObject({ range: "7d", uptime_percent: null });
    expect(urls[0]).toBe("/v1/apps/we%20b/availability?range=7d");
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().availability("web", "24h")).toBeNull();
    respond = () => ({ status: 400, body: { error: "range must be 24h, 7d or 30d" } });
    await expect(client().availability("web", "1h")).rejects.toMatchObject({ status: 400 });
  });
});
