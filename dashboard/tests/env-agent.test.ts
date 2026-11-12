import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_TOO_OLD_FOR_ENV, AgentClient, AgentError, type AgentConnection } from "@/lib/agent";
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
/** The answer to the next request: JSON, or plain text like an older agent's router. */
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

const VALUE = "postgres://user:hunter2-very-secret@db/app";

describe("agent client: managed environment variables", () => {
  it("lists the variables of a scope with the bearer token, names only", async () => {
    seen.length = 0;
    const view = { scope: "preview", vars: [{ key: "A", updated_at: "2026-10-23T10:00:00Z", build: false, shadows: "env_file" }], last_changed: "2026-10-23T10:00:00Z" };
    respond = () => ({ status: 200, body: view });
    expect(await client().envVars("shop app", "preview")).toEqual(view);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/apps/shop%20app/env?scope=preview" });
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null for an agent that has no such route (older)", async () => {
    respond = () => ({ status: 404, text: "404 page not found\n" });
    expect(await client().envVars("shop", "app")).toBeNull();
  });

  it("passes any other failure on", async () => {
    respond = () => ({ status: 500, body: { error: "boom" } });
    await expect(client().envVars("shop", "app")).rejects.toMatchObject({ status: 500, message: "boom" });
  });

  it("signs a change over the exact body and never sends the bearer token", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { scope: "app", changed: ["DATABASE_URL"], removed: ["OLD"] } });
    const out = await client().setEnv("shop", { scope: "app", set: { DATABASE_URL: VALUE }, build: [], unset: ["OLD"] });
    expect(out).toEqual({ ok: true, changed: ["DATABASE_URL"], removed: ["OLD"] });
    const r = seen[0];
    expect(r.method).toBe("PUT");
    expect(r.url).toBe("/v1/apps/shop/env");
    expect(JSON.parse(r.body)).toEqual({ scope: "app", set: { DATABASE_URL: VALUE }, build: [], unset: ["OLD"] });
    expect(r.headers.authorization).toBeUndefined();
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "PUT", "/v1/apps/shop/env", r.body));
  });

  it("returns the agent's per-key problems as a result, with no value in them", async () => {
    respond = () => ({ status: 400, body: { error: "invalid", message: `value ${VALUE} refused`, issues: [{ key: "A", message: `bad ${VALUE}` }, { key: "", message: "too many" }, "junk"] } });
    const out = await client().setEnv("shop", { scope: "app", set: { A: VALUE } });
    expect(out).toEqual({
      ok: false,
      message: "value [redacted] refused",
      issues: [
        { key: "A", message: "bad [redacted]" },
        { key: "", message: "too many" },
      ],
    });
  });

  it("tells an agent without the route to be updated, but keeps the agent's own 404 (an unknown app)", async () => {
    respond = () => ({ status: 404, text: "404 page not found\n" });
    await expect(client().setEnv("shop", { scope: "app", set: { A: "1" } })).rejects.toMatchObject({ status: 404, message: AGENT_TOO_OLD_FOR_ENV });
    respond = () => ({ status: 404, body: { error: "not found" } });
    await expect(client().setEnv("shop", { scope: "app", set: { A: "1" } })).rejects.toMatchObject({ status: 404, message: "not found" });
  });

  it("tells an agent that has the variables API (a JSON 404 for an unknown app) from one that has not (its router's plain 404)", async () => {
    seen.length = 0;
    respond = () => ({ status: 404, body: { error: "not found" } });
    expect(await client().supportsEnv()).toBe(true);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/apps/keelson-probe/env?scope=app" });
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    respond = () => ({ status: 200, body: { scope: "app", vars: [] } });
    expect(await client().supportsEnv()).toBe(true);
    respond = () => ({ status: 404, text: "404 page not found\n" });
    expect(await client().supportsEnv()).toBe(false);
    respond = () => ({ status: 500, body: { error: "boom" } });
    await expect(client().supportsEnv()).rejects.toMatchObject({ status: 500 });
  });

  it("removes a value an error message echoes, and the answer's body with it", async () => {
    respond = () => ({ status: 500, body: { error: `could not write ${VALUE}`, detail: VALUE } });
    const err = await client().setEnv("shop", { scope: "app", set: { A: VALUE } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toBe("could not write [redacted]");
    expect((err as AgentError).body).toBeUndefined();
  });

  it("deletes a scope with a signed, empty request", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, body: { scope: "preview", removed: ["A"] } });
    await client().deleteEnv("shop", "preview");
    const r = seen[0];
    expect(r).toMatchObject({ method: "DELETE", url: "/v1/apps/shop/env?scope=preview", body: "" });
    const ts = Number(r.headers["x-keelson-timestamp"]);
    expect(r.headers["x-keelson-signature"]).toBe(sign(SECRET, ts, "DELETE", "/v1/apps/shop/env?scope=preview", ""));
    respond = () => ({ status: 404, text: "404 page not found\n" });
    await expect(client().deleteEnv("shop", "app")).rejects.toMatchObject({ message: AGENT_TOO_OLD_FOR_ENV });
  });

  it("refuses to change anything for a server with no deploy secret", async () => {
    await expect(client({ deploySecret: null }).setEnv("shop", { scope: "app", set: { A: "1" } })).rejects.toMatchObject({ message: "this server has no deploy secret" });
  });
});
