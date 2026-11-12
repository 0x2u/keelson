import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KeelsonApiError, KeelsonClient } from "../src/client.ts";
import { VERSION } from "../src/version.ts";
import { startFake, TOKEN, type Fake } from "./fake.ts";

let fake: Fake;
const clientFor = (url: string, timeoutMs = 2000, token = TOKEN) => new KeelsonClient({ baseUrl: url, token, timeoutMs });
let client: KeelsonClient;

beforeEach(async () => {
  fake = await startFake();
  client = clientFor(fake.url);
});
afterEach(() => fake.close());

async function failure(promise: Promise<unknown>): Promise<KeelsonApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(KeelsonApiError);
    return err as KeelsonApiError;
  }
  throw new Error("expected the request to fail");
}

describe("requests", () => {
  test("GET sends the bearer token, accepts JSON, identifies itself and carries the query", async () => {
    fake.on("GET /api/v1/audit", { body: { entries: [] } });
    expect(await client.get("/api/v1/audit", { limit: 5, skipped: undefined })).toEqual({ entries: [] });
    const [req] = fake.requests;
    expect(req).toMatchObject({ method: "GET", path: "/api/v1/audit", query: { limit: "5" }, body: "" });
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers.accept).toBe("application/json");
    expect(req?.headers["user-agent"]).toBe(`keelson-mcp/${VERSION}`);
  });

  test("POST sends a JSON body", async () => {
    fake.on("POST /api/v1/x", { status: 202, body: { deployment_id: "d1" } });
    expect(await client.post("/api/v1/x", { tag: "v1" })).toEqual({ deployment_id: "d1" });
    expect(fake.requests[0]).toMatchObject({ method: "POST", body: '{"tag":"v1"}' });
    expect(fake.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  test("keeps a path prefix of the base URL", async () => {
    fake.on("GET /keelson/api/v1/servers", { body: { servers: [] } });
    await clientFor(`${fake.url}/keelson`).get("/api/v1/servers");
    expect(fake.requests[0]?.path).toBe("/keelson/api/v1/servers");
  });
});

describe("error mapping", () => {
  test("401 says the token is invalid, expired or revoked and nothing else", async () => {
    const bad = clientFor(fake.url, 2000, "kst_wrongwrongwrongwrongwrongwrongwrongwrongwro");
    const err = await failure(bad.get("/api/v1/servers"));
    expect(err.status).toBe(401);
    expect(err.message).toBe("Keelson rejected the token: token invalid, expired or revoked.");
  });

  test("403 carries the reason", async () => {
    fake.on("POST /api/v1/p", { status: 403, body: { error: "forbidden: token lacks the deploy scope" } });
    const err = await failure(client.post("/api/v1/p", {}));
    expect(err).toMatchObject({ status: 403, message: "Forbidden: token lacks the deploy scope." });
  });

  test("429 says when to retry, from seconds or from a date", async () => {
    fake.on("GET /a", { status: 429, body: { error: "slow down" }, headers: { "retry-after": "42" } });
    expect((await failure(client.get("/a"))).message).toBe("Rate limited by Keelson (too many failed requests). Retry after 42 s.");
    fake.on("GET /b", { status: 429, body: {}, headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() } });
    expect((await failure(client.get("/b"))).message).toMatch(/Retry after (29|30) s\./);
    fake.on("GET /c", { status: 429, body: {} });
    expect((await failure(client.get("/c"))).message).toMatch(/Retry later\./);
  });

  test("502 passes the dashboard's agent message through", async () => {
    fake.on("GET /a", { status: 502, body: { error: "agent unreachable: connection refused" } });
    expect(await failure(client.get("/a"))).toMatchObject({ status: 502, message: "agent unreachable: connection refused" });
  });

  test.each([
    [400, "bad digest", "Rejected (HTTP 400): bad digest"],
    [404, "unknown app", "Not found (HTTP 404): unknown app"],
    [409, "a deployment is already running", "Conflict (HTTP 409): a deployment is already running"],
    [500, "boom", "Keelson returned HTTP 500: boom"],
  ])("%i passes the message through", async (status, error, message) => {
    fake.on("POST /a", { status, body: { error } });
    expect(await failure(client.post("/a", {}))).toMatchObject({ status, message });
  });

  test("an error message is one bounded line, and a token in it is redacted", async () => {
    fake.on("GET /a", { status: 502, body: { error: `agent unreachable: ${TOKEN}\n\u001b[31m${"x".repeat(1000)}` } });
    const err = await failure(client.get("/a"));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("\n");
    expect(err.message).not.toContain("\u001b");
    expect(err.message.length).toBeLessThan(400);
  });

  test("error messages never contain headers", async () => {
    fake.on("GET /a", { status: 500, body: { error: "oops" }, headers: { "set-cookie": "session=topsecret", "x-internal": "leak" } });
    const err = await failure(client.get("/a"));
    expect(err.message).not.toMatch(/topsecret|leak|authorization|bearer/i);
  });

  test("a non-JSON answer is reported as such, without its content", async () => {
    fake.on("GET /a", { raw: "<html>secret page</html>" });
    expect((await failure(client.get("/a"))).message).toBe("Unexpected response from Keelson (HTTP 200, not JSON).");
    fake.on("GET /b", { status: 500, raw: "<html>secret page</html>" });
    expect((await failure(client.get("/b"))).message).toBe("Keelson returned HTTP 500");
  });

  test("a timeout is reported, and a write is not retried", async () => {
    fake.on("POST /slow", { status: 202, body: {}, delayMs: 600 });
    const err = await failure(clientFor(fake.url, 150).post("/slow", {}));
    expect(err.message).toBe(`Keelson did not answer within 150 ms (${fake.url}).`);
    await new Promise((r) => setTimeout(r, 800));
    expect(fake.requests.filter((r) => r.path === "/slow")).toHaveLength(1);
  });

  test("a failed write is not retried either", async () => {
    fake.on("POST /w", { status: 500, body: { error: "boom" } });
    await failure(client.post("/w", {}));
    expect(fake.requests).toHaveLength(1);
  });

  test("an unreachable dashboard is reported with the address, not the token", async () => {
    const url = fake.url;
    await fake.close();
    const err = await failure(clientFor(url).get("/api/v1/servers"));
    expect(err.message).toBe(`Cannot reach Keelson at ${url}: ECONNREFUSED.`);
    fake = await startFake();
  });

  test("a redirect is not followed, so the token goes nowhere else", async () => {
    const other = await startFake();
    try {
      fake.on("GET /a", { status: 302, headers: { location: `${other.url}/stolen` } });
      const err = await failure(client.get("/a"));
      expect(err.message).toBe(`Cannot reach Keelson at ${fake.url}: unexpected redirect.`);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  test("a huge response is refused", async () => {
    fake.on("GET /big", { raw: `{"x":"${"a".repeat(9 * 1024 * 1024)}"}` });
    expect((await failure(client.get("/big"))).message).toBe("Keelson's response is too large to read.");
  });
});
