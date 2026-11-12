import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-relay-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
process.env.KEELSON_AGENT_BIN_DIR = path.join(dir, "bin");

// Imported after the data dir is set: the database opens lazily on first use.
const { AgentError, agentFor } = await import("@/lib/agent");
const { db } = await import("@/lib/db");
const relay = await import("@/lib/relay");
const { RELAY_MAX_IN_FLIGHT, parseConnection, sha256Hex } = await import("@/lib/relay-core");
const servers = await import("@/lib/servers");
const { GET: connectRoute } = await import("@/app/api/relay/connect/route");
const { POST: enrolRoute } = await import("@/app/api/relay/enrol/route");
const { POST: responseRoute } = await import("@/app/api/relay/response/[id]/route");
const { GET: binaryRoute } = await import("@/app/api/relay/binary/route");
const { GET: bodyRoute } = await import("@/app/api/relay/request/[id]/body/route");

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);
const ORIGIN = "http://dash.test";

// ---- A fake agent that speaks the relay contract, against the real route handlers (no network) ----------------------

interface Line {
  type: string;
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  server_id?: string;
  stream?: boolean;
}

interface Machine {
  id: string;
  credential: string;
}

let nameCounter = 0;
/** A relay server as enrolment leaves it, without going through the enrolment. */
function machine(): Machine {
  const credential = `credential-${nameCounter}-${"c".repeat(30)}`;
  const { id } = servers.createRelayServer({ name: `mac-${nameCounter++}`, token: TOKEN, deploySecret: SECRET, credentialHash: sha256Hex(credential), serves: false });
  return { id, credential };
}

const aborts: AbortController[] = [];

class FakeAgent {
  private lines: Line[] = [];
  private waiting: ((l: Line) => void)[] = [];
  readonly ended: Promise<void>;

  private constructor(
    readonly machine: Machine,
    body: ReadableStream<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    aborts.push(controller);
    this.ended = this.pump(body);
  }

  /** `features` is what the machine announces in X-Relay-Features (null: it sends no such header, like an older agent). */
  static async connect(m: Machine, features: string | null = "request-stream"): Promise<FakeAgent> {
    const controller = new AbortController();
    const headers: Record<string, string> = { Authorization: `Bearer ${m.credential}` };
    if (features !== null) headers["X-Relay-Features"] = features;
    const res = await connectRoute(new Request(`${ORIGIN}/api/relay/connect`, { headers, signal: controller.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    return new FakeAgent(m, res.body!, controller);
  }

  /** The machine goes away: its connection request is aborted, as Node does when the socket closes. */
  drop(): void {
    this.controller.abort();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, i)) as Line;
        buffer = buffer.slice(i + 1);
        const waiter = this.waiting.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    }
  }

  next(): Promise<Line> {
    const line = this.lines.shift();
    if (line) return Promise.resolve(line);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** The next line that is a request (hello and pings are skipped). */
  async request(): Promise<Line> {
    for (;;) {
      const line = await this.next();
      if (line.type === "request") return line;
    }
  }

  /** One chunk POST of the answer to `id`. */
  respond(id: string, seq: number, o: { status?: number; headers?: Record<string, string>; end?: boolean; body?: string | Uint8Array; credential?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${o.credential ?? this.machine.credential}`, "X-Relay-Seq": String(seq) };
    if (seq === 0) {
      headers["X-Relay-Status"] = String(o.status ?? 200);
      headers["X-Relay-Headers"] = Buffer.from(JSON.stringify(o.headers ?? {})).toString("base64");
    }
    if (o.end) headers["X-Relay-End"] = "1";
    return responseRoute(new Request(`${ORIGIN}/api/relay/response/${id}`, { method: "POST", headers, body: o.body as BodyInit | undefined }), { params: Promise.resolve({ id }) });
  }

  /** Answers a whole request at once. */
  async answer(id: string, o: { status?: number; json?: unknown; body?: string }): Promise<void> {
    const res = await this.respond(id, 0, {
      status: o.status,
      headers: { "Content-Type": "application/json" },
      end: true,
      body: o.json === undefined ? o.body : JSON.stringify(o.json),
    });
    expect(res.status).toBe(200);
  }

  /** The machine's GET for the body of request `id`; `signal` is its connection (aborted when it drops). */
  body(id: string, o: { credential?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = { Authorization: `Bearer ${o.credential ?? this.machine.credential}` };
    return bodyRoute(new Request(`${ORIGIN}/api/relay/request/${id}/body`, { headers, signal: o.signal }), { params: Promise.resolve({ id }) });
  }
}

/** Whether `p` is still waiting after everything that could settle it has run (streams settle in microtasks: a few turns of the loop are plenty). */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  return !done;
}

const GET = (path: string) => ({ method: "GET", path, headers: {} });

beforeAll(() => {
  db().exec("DELETE FROM servers");
});
afterEach(() => {
  for (const c of aborts.splice(0)) c.abort();
  db().exec("DELETE FROM login_failures");
  vi.useRealTimers();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---- Requests and answers ------------------------------------------------------------------------------------------

describe("a request to a machine that connected out", () => {
  it("goes down its connection as the agent's own request and comes back as the Response the agent answered", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    expect(await agent.next()).toEqual({ type: "hello", server_id: m.id, ping_every: 15 });

    const result = relay.relayFetch(m.id, { method: "POST", path: "/v1/x?y=1", headers: { Authorization: "Bearer abc", "Content-Type": "application/json" }, body: '{"a":"é"}' });
    const req = await agent.request();
    expect(req).toMatchObject({ method: "POST", path: "/v1/x?y=1", headers: { Authorization: "Bearer abc", "Content-Type": "application/json" } });
    expect(Buffer.from(req.body!, "base64").toString()).toBe('{"a":"é"}');
    expect(req.id).toMatch(/^[0-9a-f]{16}$/);

    await agent.respond(req.id!, 0, { status: 201, headers: { "Content-Type": "application/json", "X-Extra": "1" }, end: true, body: '{"ok":true}' });
    const res = await result;
    expect(res.status).toBe(201);
    expect(res.headers.get("x-extra")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("sends no body field for a request without one", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    void relay.relayFetch(m.id, GET("/v1/health")).catch(() => {});
    expect((await agent.request()).body).toBeUndefined();
  });

  it("delivers a streamed answer's chunks in order, the head first", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/containers/web/logs"));
    const { id } = await agent.request();

    expect((await agent.respond(id!, 0, { status: 200, headers: { "Content-Type": "text/event-stream" } })).status).toBe(200);
    const res = await result;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();

    const sent = ["one\n", "two\n", "three\n"];
    const posted = (async () => {
      for (const [i, text] of sent.entries()) expect((await agent.respond(id!, i + 1, { body: text })).status).toBe(200);
      expect((await agent.respond(id!, 4, { end: true })).status).toBe(200);
    })();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await posted;
    expect(text).toBe("one\ntwo\nthree\n");
  });

  it("holds the next chunk's POST while the consumer has not taken what it has (backpressure)", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/big"));
    const { id } = await agent.request();

    // Nobody reads yet: one chunk fits in the stream, the next has to wait until the first has been taken.
    expect((await agent.respond(id!, 0, { body: "A" })).status).toBe(200);
    const res = await result;
    const second = agent.respond(id!, 1, { body: "B" });
    expect(await pending(second)).toBe(true);

    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("A");
    expect((await second).status).toBe(200);
    const third = agent.respond(id!, 2, { body: "C" });
    expect(await pending(third)).toBe(true);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("B");
    expect((await third).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("C");
  });

  it("refuses a chunk sent while the previous one is still held, so a machine cannot buffer past the backpressure", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/big"));
    const { id } = await agent.request();
    await agent.respond(id!, 0, { body: "A" });
    const res = await result;
    const second = agent.respond(id!, 1, { body: "B" });
    expect(await pending(second)).toBe(true);

    // Chunk 2 arrives (another connection) while chunk 1's POST is still waiting for the consumer.
    expect((await agent.respond(id!, 2, { body: "C" })).status).toBe(409);

    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("A");
    expect((await second).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("B");
  });

  it("tells the machine to cancel when the caller gives up before the head, and refuses its late answer with 410", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const abort = new AbortController();
    const result = relay.relayFetch(m.id, { ...GET("/v1/slow"), signal: abort.signal }).catch((e: unknown) => e);
    const { id } = await agent.request();

    abort.abort(new DOMException("timed out", "TimeoutError"));
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(await agent.next()).toEqual({ type: "cancel", id });
    expect((await agent.respond(id!, 0, { end: true })).status).toBe(410);
  });

  it("tells the machine to cancel when the caller gives up mid-body, and the body fails", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const abort = new AbortController();
    const result = relay.relayFetch(m.id, { ...GET("/v1/stream"), signal: abort.signal });
    const { id } = await agent.request();
    await agent.respond(id!, 0, { body: "x" });
    const res = await result;
    const reader = res.body!.getReader();
    await reader.read();

    abort.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(await agent.next()).toEqual({ type: "cancel", id });
    expect((await agent.respond(id!, 1, { body: "y" })).status).toBe(410);
  });

  it("tells the machine to cancel when the consumer drops the body", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/stream"));
    const { id } = await agent.request();
    await agent.respond(id!, 0, { body: "x" });
    await (await result).body!.cancel();

    expect(await agent.next()).toEqual({ type: "cancel", id });
    expect((await agent.respond(id!, 1, { body: "y" })).status).toBe(410);
  });

  it("answers a 204 without a body", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/x"));
    const { id } = await agent.request();
    expect((await agent.respond(id!, 0, { status: 204, end: true })).status).toBe(200);
    const res = await result;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("refuses more than 64 in flight to one machine, and a body over 1 MiB before sending anything", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    for (let i = 0; i < RELAY_MAX_IN_FLIGHT; i++) void relay.relayFetch(m.id, GET(`/v1/${i}`)).catch(() => {});
    await expect(relay.relayFetch(m.id, GET("/v1/65"))).rejects.toMatchObject({ status: 429 });

    await expect(relay.relayFetch(m.id, { method: "POST", path: "/v1/big", headers: {}, body: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413 });
    let requests = 0;
    for (let i = 0; i < RELAY_MAX_IN_FLIGHT; i++) {
      await agent.request();
      requests++;
    }
    expect(requests).toBe(RELAY_MAX_IN_FLIGHT);
  });
});

describe("the chunks of an answer", () => {
  it("must come in sequence, only to the machine that was asked, and not after the end", async () => {
    const m = machine();
    const other = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/x"));
    const { id } = await agent.request();

    expect((await agent.respond(id!, 1, { body: "late" })).status).toBe(409);
    expect((await agent.respond(id!, 0, { credential: other.credential, body: "mine" })).status).toBe(404);
    expect((await agent.respond("0123456789abcdef", 0)).status).toBe(404);
    expect((await agent.respond(id!, 0, { credential: "nope" })).status).toBe(401);

    expect((await agent.respond(id!, 0, { end: true, body: "a" })).status).toBe(200);
    expect(await (await result).text()).toBe("a");
  });

  it("are refused with 409 once the answer has ended, and a chunk over 4 MiB with 413", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/x"));
    const { id } = await agent.request();
    await agent.respond(id!, 0, { end: true, body: "done" });
    expect(await (await result).text()).toBe("done");
    expect((await agent.respond(id!, 1, { body: "more" })).status).toBe(409);

    const second = relay.relayFetch(m.id, GET("/v1/y")).catch((e: unknown) => e);
    const next = await agent.request();
    expect((await agent.respond(next.id!, 0, { body: new Uint8Array(4 * 1024 * 1024 + 1) })).status).toBe(413);
    expect(await second).toMatchObject({ status: 502 });
  });

  it("need a valid status in the head", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const result = relay.relayFetch(m.id, GET("/v1/x")).catch((e: unknown) => e);
    const { id } = await agent.request();
    expect((await agent.respond(id!, 0, { status: 99 })).status).toBe(400);
    expect(await result).toMatchObject({ status: 502 });
  });
});

// ---- Connections ---------------------------------------------------------------------------------------------------

describe("the connection of a machine", () => {
  it("is replaced by a new one: the old is told so and closed, its requests fail, the new one works", async () => {
    const m = machine();
    const first = await FakeAgent.connect(m);
    const inFlight = relay.relayFetch(m.id, GET("/v1/x")).catch((e: unknown) => e);
    await first.request();

    const second = await FakeAgent.connect(m);
    expect(await first.next()).toEqual({ type: "replaced" });
    await first.ended;
    expect(await inFlight).toMatchObject({ name: "RelayError", status: 502 });
    expect(relay.relayStatus(m.id).connected).toBe(true);

    const result = relay.relayFetch(m.id, GET("/v1/y"));
    await second.answer((await second.request()).id!, { json: { ok: 1 } });
    expect(await (await result).json()).toEqual({ ok: 1 });
  });

  it("is reported by relayStatus, and fails what was in flight when it drops", async () => {
    const m = machine();
    expect(relay.relayStatus(m.id)).toEqual({ connected: false, lastSeen: null, features: [] });
    const agent = await FakeAgent.connect(m);
    expect(relay.relayStatus(m.id).connected).toBe(true);
    const inFlight = relay.relayFetch(m.id, GET("/v1/x")).catch((e: unknown) => e);
    await agent.request();

    agent.drop();
    expect(await inFlight).toMatchObject({ name: "RelayError", status: 0 });
    expect(relay.relayStatus(m.id)).toEqual({ connected: false, lastSeen: expect.any(Number), features: [] });
    await expect(relay.relayFetch(m.id, GET("/v1/y"))).rejects.toMatchObject({ status: 0, message: "the agent on this server is not connected to the dashboard" });
  });

  it("says when it was made, which moves when the agent connects again (a restarted agent does)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_800_000_000_000);
      const m = machine();
      expect(relay.relayConnectedAt(m.id)).toBeNull();
      const first = await FakeAgent.connect(m);
      expect(relay.relayConnectedAt(m.id)).toBe(1_800_000_000_000);
      first.drop();
      expect(relay.relayConnectedAt(m.id)).toBeNull();
      vi.setSystemTime(1_800_000_090_000);
      await FakeAgent.connect(m);
      expect(relay.relayConnectedAt(m.id)).toBe(1_800_000_090_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused for an unknown credential", async () => {
    const res = await connectRoute(new Request(`${ORIGIN}/api/relay/connect`, { headers: { Authorization: "Bearer nobody" } }));
    expect(res.status).toBe(401);
    expect((await connectRoute(new Request(`${ORIGIN}/api/relay/connect`))).status).toBe(401);
  });

  it("pings every 15 seconds, and is closed when its server is removed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const m = machine();
    const agent = await FakeAgent.connect(m);
    await agent.next(); // hello
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await agent.next()).toEqual({ type: "ping" });

    servers.deleteServer(m.id);
    await vi.advanceTimersByTimeAsync(15_000);
    await agent.ended;
    expect(relay.relayStatus(m.id).connected).toBe(false);
    expect((await connectRoute(new Request(`${ORIGIN}/api/relay/connect`, { headers: { Authorization: `Bearer ${m.credential}` } }))).status).toBe(401);
  });
});

// ---- Enrolment ----------------------------------------------------------------------------------------------------

const enrolBody = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: "marc-mac",
  token: "a".repeat(40),
  deploy_secret: "b".repeat(40),
  version: "abc1234",
  os: "darwin",
  arch: "arm64",
  hostname: "marcs-mac.local",
  ...over,
});

const enrol = (body: unknown) =>
  enrolRoute(new Request(`${ORIGIN}/api/relay/enrol`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("enrolment", () => {
  it("spends the code and registers a relay server with the secrets the machine chose, handing back its credential once", async () => {
    const { code } = relay.createRelayCode(ORIGIN);
    const res = await enrol(enrolBody(code));
    expect(res.status).toBe(200);
    const granted = (await res.json()) as { credential: string; server_id: string; name: string };
    expect(granted.name).toBe("marc-mac");

    const server = servers.getServer(granted.server_id)!;
    expect(server).toMatchObject({ transport: "relay", url: "", canDeploy: true, caCert: null, clientCert: null, hasClientKey: false });
    const creds = servers.getCredentials(granted.server_id)!;
    expect(creds.token).toBe("a".repeat(40));
    expect(creds.deploySecret).toBe("b".repeat(40));
    expect(JSON.stringify(db().prepare("SELECT * FROM servers WHERE id = ?").get(granted.server_id))).not.toContain(granted.credential);
    expect(servers.serverByCredentialHash(sha256Hex(granted.credential))?.id).toBe(granted.server_id);

    expect(relay.relayCodeValid(code)).toBe(false);
    expect(db().prepare("SELECT detail FROM audit_log WHERE event = 'relay_enrol' ORDER BY id DESC").get()).toEqual({ detail: "marc-mac (darwin/arm64)" });
    expect(server.serves).toBe(false);
  });

  it("registers a server that runs apps when the agent says it serves, and records it as a server, not a build machine", async () => {
    const { code } = relay.createRelayCode(ORIGIN);
    const res = await enrol(enrolBody(code, { name: "vps-1", os: "linux", arch: "amd64", serves: true }));
    expect(res.status).toBe(200);
    const granted = (await res.json()) as { server_id: string };
    expect(servers.getServer(granted.server_id)).toMatchObject({ transport: "relay", serves: true });
    expect(db().prepare("SELECT detail FROM audit_log WHERE event = 'relay_enrol_server' ORDER BY id DESC").get()).toEqual({ detail: "vps-1 (linux/amd64)" });
  });

  it("refuses an enrolment whose serves flag is not a boolean, and keeps the code", async () => {
    const { code } = relay.createRelayCode(ORIGIN);
    expect((await enrol(enrolBody(code, { serves: "yes" }))).status).toBe(400);
    expect(relay.relayCodeValid(code)).toBe(true);
  });

  it("refuses an unknown, a used and an expired code with one and the same answer", async () => {
    const used = relay.createRelayCode(ORIGIN).code;
    expect((await enrol(enrolBody(used))).status).toBe(200);
    const expired = relay.createRelayCode(ORIGIN).code;
    db().prepare("UPDATE relay_codes SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, sha256Hex(expired));

    const answers = [];
    for (const code of ["unknown", used, expired]) {
      const res = await enrol(enrolBody(code, { name: "other" }));
      answers.push([res.status, await res.json()]);
    }
    expect(answers).toEqual(Array(3).fill([401, { error: "invalid or expired code" }]));
    expect(relay.relayCodeValid(expired)).toBe(false);
  });

  it("lets only one of two simultaneous enrolments with the same code win", () => {
    const { code } = relay.createRelayCode(ORIGIN);
    expect([relay.consumeRelayCode(code), relay.consumeRelayCode(code)]).toEqual([true, false]);
  });

  it("makes a taken name unique with a numeric suffix", async () => {
    const names = [];
    for (let i = 0; i < 3; i++) {
      const res = await enrol(enrolBody(relay.createRelayCode(ORIGIN).code, { name: "dup" }));
      names.push(((await res.json()) as { name: string }).name);
    }
    expect(names).toEqual(["dup", "dup-2", "dup-3"]);
  });

  it.each([
    ["a name no server may have", { name: "bad/name" }],
    ["no name", { name: "" }],
    ["a token that is too short", { token: "short" }],
    ["a deploy secret equal to the token", { deploy_secret: "a".repeat(40) }],
    ["a code that is not text", { code: 7 }],
  ])("answers 400 for %s and keeps the code", async (_what, over) => {
    const { code } = relay.createRelayCode(ORIGIN);
    expect((await enrol(enrolBody(code, over))).status).toBe(400);
    if (!("code" in over)) expect(relay.relayCodeValid(code)).toBe(true);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await enrolRoute(new Request(`${ORIGIN}/api/relay/enrol`, { method: "POST", body: "nope" }));
    expect(res.status).toBe(400);
  });

  it("throttles a client that keeps failing, even for a good code", async () => {
    for (let i = 0; i < 5; i++) expect((await enrol(enrolBody("wrong"))).status).toBe(401);
    const { code } = relay.createRelayCode(ORIGIN);
    const blocked = await enrol(enrolBody(code));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(relay.relayCodeValid(code)).toBe(true);
  });

  it("hands out a code that is valid for 30 minutes and carries the dashboard's address in its connection string", async () => {
    const before = Date.now();
    const made = relay.createRelayCode(ORIGIN);
    expect(made.expiresAt - before).toBeGreaterThanOrEqual(30 * 60_000);
    expect(made.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(parseConnection(made.connection)).toEqual({ url: ORIGIN, code: made.code });
    expect(JSON.stringify(db().prepare("SELECT * FROM relay_codes").all())).not.toContain(made.code);
  });
});

describe("editing a relay server", () => {
  it("keeps it without an address or certificates, whatever the form sends", () => {
    const { id } = machine();
    expect(servers.updateServer(id, { name: "renamed", url: "https://nope.example.com", caCert: "x", clientCert: "y", clientKey: "z" })).toBe(true);
    expect(servers.getServer(id)).toMatchObject({ name: "renamed", transport: "relay", url: "", caCert: null, clientCert: null, hasClientKey: false });
  });
});

// ---- Credentials ---------------------------------------------------------------------------------------------------

describe("the relay credential", () => {
  it("proves only which machine is calling: it cannot answer another machine's request", async () => {
    const a = machine();
    const b = machine();
    const agentA = await FakeAgent.connect(a);
    const agentB = await FakeAgent.connect(b);
    void agentB;
    const result = relay.relayFetch(a.id, GET("/v1/secret"));
    const { id } = await agentA.request();

    // B knows the id (say it was guessed) and has a valid credential of its own.
    expect((await agentB.respond(id!, 0, { end: true, body: "forged" })).status).toBe(404);
    expect((await agentA.respond(id!, 0, { end: true, body: "real" })).status).toBe(200);
    expect(await (await result).text()).toBe("real");
  });

  it("is not accepted after the machine is removed", async () => {
    const m = machine();
    servers.deleteServer(m.id);
    const res = await responseRoute(new Request(`${ORIGIN}/api/relay/response/0123`, { method: "POST", headers: { Authorization: `Bearer ${m.credential}`, "X-Relay-Seq": "0" } }), {
      params: Promise.resolve({ id: "0123" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---- The binary ----------------------------------------------------------------------------------------------------

describe("the agent binary for a connecting machine", () => {
  const get = (query: string) => binaryRoute(new Request(`${ORIGIN}/api/relay/binary?${query}`));

  beforeAll(() => {
    const bin = path.join(dir, "bin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "keelson-agent-darwin-arm64"), "mach-o bytes");
    writeFileSync(path.join(bin, "keelson-agent-linux-amd64"), "elf bytes");
  });

  it("is served for a valid code, with its checksum, and the code stays valid for the enrolment", async () => {
    const { code } = relay.createRelayCode(ORIGIN);
    const res = await get(`os=darwin&arch=arm64&code=${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-checksum-sha256")).toBe(sha256Hex("mach-o bytes"));
    expect(await res.text()).toBe("mach-o bytes");
    expect(relay.relayCodeValid(code)).toBe(true);
    expect(await (await get(`os=linux&arch=amd64&code=${code}`)).text()).toBe("elf bytes");
  });

  it("needs a code that is valid: unknown, missing, used and expired are all refused", async () => {
    const used = relay.createRelayCode(ORIGIN).code;
    await enrol(enrolBody(used, { name: "gone" }));
    const expired = relay.createRelayCode(ORIGIN).code;
    db().prepare("UPDATE relay_codes SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, sha256Hex(expired));
    for (const query of ["os=darwin&arch=arm64", "os=darwin&arch=arm64&code=nope", `os=darwin&arch=arm64&code=${used}`, `os=darwin&arch=arm64&code=${expired}`]) {
      expect((await get(query)).status, query).toBe(401);
    }
  });

  it("answers 404 for a platform there is no binary for", async () => {
    const { code } = relay.createRelayCode(ORIGIN);
    for (const query of ["os=windows&arch=amd64", "os=linux&arch=riscv", "os=darwin&arch=amd64", "arch=amd64"]) {
      expect((await get(`${query}&code=${code}`)).status, query).toBe(404);
    }
  });
});

// ---- The kind of a code --------------------------------------------------------------------------------------------

describe("an upgrade code", () => {
  const getBinary = (code: string) => binaryRoute(new Request(`${ORIGIN}/api/relay/binary?os=linux&arch=amd64&code=${code}`));

  it("lets the server it was made for download the agent, and nothing else", async () => {
    const m = machine();
    const { code } = relay.createRelayCode(ORIGIN, "upgrade", m.id);
    expect(relay.relayCodeValid(code)).toBe(true);
    expect(relay.relayCodeAllowsBinary(code)).toBe(true);
    expect((await getBinary(code)).status).toBe(200);
    // The download does not spend it: the update command may be run again within its 30 minutes.
    expect((await getBinary(code)).status).toBe(200);
  });

  it("enrols nothing: the enrolment refuses it, keeps it and creates no server", async () => {
    const m = machine();
    const { code } = relay.createRelayCode(ORIGIN, "upgrade", m.id);
    const before = db().prepare("SELECT COUNT(*) AS n FROM servers").get();
    expect(relay.consumeRelayCode(code)).toBe(false);
    const res = await enrol(enrolBody(code, { name: "intruder", serves: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid or expired code" });
    expect(db().prepare("SELECT COUNT(*) AS n FROM servers").get()).toEqual(before);
    expect(db().prepare("SELECT used_at FROM relay_codes WHERE code_hash = ?").get(sha256Hex(code))).toEqual({ used_at: null });
  });

  it("is refused once its server is gone", async () => {
    const m = machine();
    const { code } = relay.createRelayCode(ORIGIN, "upgrade", m.id);
    servers.deleteServer(m.id);
    expect(relay.relayCodeAllowsBinary(code)).toBe(false);
    expect((await getBinary(code)).status).toBe(401);
  });

  it("is refused once it expired, like any code", async () => {
    const m = machine();
    const { code } = relay.createRelayCode(ORIGIN, "upgrade", m.id);
    db().prepare("UPDATE relay_codes SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, sha256Hex(code));
    expect((await getBinary(code)).status).toBe(401);
  });

  it("is made for a server: one for nobody is not made", () => {
    expect(() => relay.createRelayCode(ORIGIN, "upgrade")).toThrow(/for a server/);
  });

  it("is told apart from an enrolment code in the database, and a row from before the column is an enrolment code", () => {
    const m = machine();
    const up = relay.createRelayCode(ORIGIN, "upgrade", m.id).code;
    const en = relay.createRelayCode(ORIGIN).code;
    expect(db().prepare("SELECT kind, server_id FROM relay_codes WHERE code_hash = ?").get(sha256Hex(up))).toEqual({ kind: "upgrade", server_id: m.id });
    expect(db().prepare("SELECT kind, server_id FROM relay_codes WHERE code_hash = ?").get(sha256Hex(en))).toEqual({ kind: "enrol", server_id: null });
    db().prepare("INSERT INTO relay_codes (code_hash, created_at, expires_at) VALUES ('old-row', 1, ?)").run(Date.now() + 60_000);
    expect(db().prepare("SELECT kind FROM relay_codes WHERE code_hash = 'old-row'").get()).toEqual({ kind: "enrol" });
    db().prepare("DELETE FROM relay_codes WHERE code_hash = 'old-row'").run();
  });
});

describe("an enrolment code", () => {
  it("still enrols, and still downloads the agent first, as before the kinds existed", async () => {
    const { code } = relay.createRelayCode(ORIGIN, "enrol");
    expect(relay.relayCodeAllowsBinary(code)).toBe(true);
    expect((await enrol(enrolBody(code, { name: "plain-enrol" }))).status).toBe(200);
    expect(relay.relayCodeAllowsBinary(code)).toBe(false);
  });
});

// ---- An AgentClient call over the relay, end to end ----------------------------------------------------------------

describe("AgentClient on a relay server", () => {
  /** A relay server as the enrolment route registers it, so the credentials are the ones the machine chose. */
  async function enrolled(): Promise<{ machine: Machine; client: ReturnType<typeof agentFor> }> {
    const res = await enrol(enrolBody(relay.createRelayCode(ORIGIN).code, { name: `e2e-${nameCounter++}` }));
    const granted = (await res.json()) as { credential: string; server_id: string };
    return { machine: { id: granted.server_id, credential: granted.credential }, client: agentFor(servers.getCredentials(granted.server_id)!) };
  }

  it("travels the relay with the agent's own bearer token, and answers like a direct one", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const containers = client.containers(false);
    const req = await agent.request();
    expect(req).toMatchObject({ method: "GET", path: "/v1/containers?all=false", headers: { Authorization: `Bearer ${"a".repeat(40)}` } });
    await agent.answer(req.id!, { json: [{ name: "web" }] });
    expect(await containers).toEqual([{ name: "web" }]);
  });

  it("signs a deployment with the deploy secret the machine chose", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const deployment = client.deploy("web", { tag: "v1" });
    const req = await agent.request();
    expect(req.headers).toMatchObject({ "X-Keelson-Signature": expect.stringMatching(/^[0-9a-f]+$/) });
    expect(req.headers!.Authorization).toBeUndefined();
    expect(Buffer.from(req.body!, "base64").toString()).toBe('{"tag":"v1"}');
    await agent.answer(req.id!, { status: 202, json: { deployment_id: "d1" } });
    expect(await deployment).toBe("d1");
  });

  it("turns the machine's error answers into AgentError like a direct agent's", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const call = client.container("nope").catch((e: unknown) => e);
    await agent.answer((await agent.request()).id!, { status: 404, json: { error: "no such container" } });
    expect(await call).toMatchObject({ name: "AgentError", status: 404, message: "no such container" });
  });

  it("streams a long answer (an image export) without waiting for its end", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const exported = client.exportImageByRef({ image: "keelson-local/web", tag: "v1" });
    const { id } = await agent.request();
    await agent.respond(id!, 0, { headers: { "Content-Type": "application/x-tar" }, body: "first" });
    const res = await exported;
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await agent.respond(id!, 1, { end: true, body: "last" });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
    expect((await reader.read()).done).toBe(true);
  });

  it("fails with a clear AgentError (status 0) when the machine is not connected", async () => {
    const { client } = await enrolled();
    const error = await client.containers(false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ status: 0, message: "cannot reach the agent: the agent on this server is not connected to the dashboard" });
  });

  it("is healthy only while connected and the agent answers /v1/health", async () => {
    const { machine: m, client } = await enrolled();
    expect(await client.healthy()).toBe(false);
    const agent = await FakeAgent.connect(m);
    const healthy = client.healthy();
    const req = await agent.request();
    expect(req).toMatchObject({ method: "GET", path: "/v1/health" });
    await agent.answer(req.id!, { json: { status: "ok" } });
    expect(await healthy).toBe(true);

    const unhealthy = client.healthy();
    await agent.answer((await agent.request()).id!, { status: 503, json: { error: "docker is down" } });
    expect(await unhealthy).toBe(false);
  });

  it("refuses a request body over 1 MiB before anything is sent", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    await expect(client.raw("/v1/x", { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413 });

    // Nothing reached the machine: the next request it sees is this one.
    const call = client.containers(false);
    const req = await agent.request();
    expect(req.path).toBe("/v1/containers?all=false");
    await agent.answer(req.id!, { json: [] });
    await call;
  });

  it("sends an image as a stream the machine fetches itself, signed without the archive", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const archive = randomBytes(3 * 1024 * 1024 + 17);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const imported = client.importImage("web", "v1", { stream: Readable.from(pieces(archive, 64 * 1024)), sha256 });

    const req = await agent.request();
    expect(req).toMatchObject({ method: "PUT", path: `/v1/apps/web/image/v1?sha256=${sha256}`, stream: true, headers: { "Content-Type": "application/x-tar", "X-Keelson-Signature": expect.stringMatching(/^[0-9a-f]+$/) } });
    expect(req.body).toBeUndefined();
    const received = Buffer.from(await (await agent.body(req.id!)).arrayBuffer());
    expect(createHash("sha256").update(received).digest("hex")).toBe(sha256);
    await agent.respond(req.id!, 0, { status: 204, end: true });
    await imported;
  });

  it("tells the operator to update an agent that cannot receive an image over the relay, before anything is sent", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m, null); // an agent from before streamed bodies: it announces no feature
    const archive = Readable.from(pieces(randomBytes(1024), 512));
    const error = await client.importImage("web", "v1", { stream: archive, sha256: "0".repeat(64) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ status: 400, message: "update the agent on this server: it cannot receive an image over the relay yet" });
    expect(archive.destroyed).toBe(true);

    const call = client.containers(false);
    expect((await agent.request()).path).toBe("/v1/containers?all=false");
    void call.catch(() => {});
  });

  it("gives up with the caller's own timeout when the machine never answers", async () => {
    const { machine: m, client } = await enrolled();
    const agent = await FakeAgent.connect(m);
    const abort = new AbortController();
    const call = client.raw("/v1/slow", { signal: abort.signal }).catch((e: unknown) => e);
    const { id } = await agent.request();
    abort.abort(new DOMException("timed out", "TimeoutError"));
    expect(await call).toMatchObject({ name: "AgentError", status: 0, message: "cannot reach the agent: timed out" });
    expect(await agent.next()).toEqual({ type: "cancel", id });
  });
});

// ---- A request body streamed to the machine -------------------------------------------------------------------------

/** `data` in pieces of `size` bytes (the last one shorter). */
function* pieces(data: Buffer, size: number): Generator<Buffer> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

/** A web stream of `count` chunks that says how much of it was read and whether it was given up. */
function counted(chunk: Uint8Array, count: number): { stream: ReadableStream<Uint8Array>; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= count) {
          controller.close();
          return;
        }
        state.pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }, // read only when somebody reads
  );
  return { stream, state };
}

/** Lets every promise and stream that can settle do so. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

const putImage = (m: Machine, stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream, extra: { signal?: AbortSignal } = {}) =>
  relay.relayFetch(m.id, { method: "PUT", path: "/v1/apps/web/image/v1?sha256=0", headers: { "Content-Type": "application/x-tar" }, stream, ...extra });

describe("a request body streamed to a machine", () => {
  it("goes as `stream: true` without a body in the line, and the machine fetches it once, whole and in order", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const archive = randomBytes(6 * 1024 * 1024 + 5);
    const result = putImage(m, Readable.from(pieces(archive, 100_000)));
    const req = await agent.request();
    expect(req).toMatchObject({ type: "request", method: "PUT", path: "/v1/apps/web/image/v1?sha256=0", stream: true });
    expect(req.body).toBeUndefined();

    const res = await agent.body(req.id!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.length).toBe(archive.length);
    expect(received.equals(archive)).toBe(true);

    expect((await agent.body(req.id!)).status).toBe(409);
    await agent.respond(req.id!, 0, { status: 204, end: true });
    expect((await result).status).toBe(204);
    expect((await agent.body(req.id!)).status).toBe(410);
  });

  it("is read from its source only as fast as the machine takes it", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const { stream, state } = counted(new Uint8Array(64 * 1024), Number.POSITIVE_INFINITY);
    void putImage(m, stream).catch(() => {});
    const req = await agent.request();
    await settle();
    expect(state.pulled).toBe(0); // nothing is read before the machine asks for the body

    const reader = (await agent.body(req.id!)).body!.getReader();
    for (let i = 0; i < 3; i++) await reader.read();
    await settle();
    // Three were taken, and at most a couple wait in the pipe: an endless source is not drained into memory.
    expect(state.pulled).toBeGreaterThanOrEqual(3);
    expect(state.pulled).toBeLessThanOrEqual(5);

    await reader.cancel(); // the machine hangs up
    expect(state.cancelled).toBe(true);
  });

  it("is cancelled when the caller gives up, and the machine is told to cancel and refused its body", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);
    const abort = new AbortController();
    const result = putImage(m, stream, { signal: abort.signal }).catch((e: unknown) => e);
    const { id } = await agent.request();

    abort.abort(new DOMException("timed out", "TimeoutError"));
    expect(await result).toMatchObject({ name: "TimeoutError" });
    await settle();
    expect(state.cancelled).toBe(true);
    expect(await agent.next()).toEqual({ type: "cancel", id });
    expect((await agent.body(id!)).status).toBe(410);
  });

  it("is cancelled when the connection is lost, also while the machine is reading it", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);
    const result = putImage(m, stream).catch((e: unknown) => e);
    const { id } = await agent.request();
    const reader = (await agent.body(id!)).body!.getReader();
    await reader.read();

    agent.drop();
    expect(await result).toMatchObject({ name: "RelayError", status: 0 });
    await settle();
    expect(state.cancelled).toBe(true);
    await expect(reader.read()).rejects.toMatchObject({ name: "RelayError" });
  });

  it("is cancelled when the machine's own GET drops, and the machine still answers the request", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);
    const result = putImage(m, stream);
    const { id } = await agent.request();
    const hangUp = new AbortController();
    await (await agent.body(id!, { signal: hangUp.signal })).body!.getReader().read();

    hangUp.abort();
    await settle();
    expect(state.cancelled).toBe(true);
    // What the machine made of a body that stopped is its to say (a 400 "not received completely").
    await agent.answer(id!, { status: 400, json: { error: "the archive was not received completely" } });
    expect((await result).status).toBe(400);
  });

  it("is cancelled when the request ends without the machine having read it", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);
    const result = putImage(m, stream);
    const { id } = await agent.request();
    await agent.answer(id!, { status: 400, json: { error: "that is not a valid image tag" } });
    expect((await result).status).toBe(400);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(0);
    expect((await agent.body(id!)).status).toBe(410);
  });

  it("is refused with a clear error, and cancelled, by a machine that does not say it can receive one", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m, null);
    expect(relay.relayStatus(m.id).features).toEqual([]);
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);

    await expect(putImage(m, stream)).rejects.toMatchObject({ name: "RelayError", status: 400, message: "update the agent on this server: it cannot receive an image over the relay yet" });
    expect(state.cancelled).toBe(true);

    // Nothing was sent: the next request the machine sees is this one.
    void relay.relayFetch(m.id, GET("/v1/health")).catch(() => {});
    expect((await agent.request()).path).toBe("/v1/health");
  });

  it("records what the machine announced when it connected", async () => {
    const m = machine();
    await FakeAgent.connect(m, "request-stream, future-thing,, Not A Name");
    expect(relay.relayStatus(m.id).features).toEqual(["future-thing", "request-stream"]);
  });

  it("is cancelled when there is no machine to send it to", async () => {
    const { stream, state } = counted(new Uint8Array(1024), Number.POSITIVE_INFINITY);
    await expect(putImage(machine(), stream)).rejects.toMatchObject({ status: 0, message: "the agent on this server is not connected to the dashboard" });
    expect(state.cancelled).toBe(true);
  });

  it("is exclusive with a body in the line, and a body in the line is still held to 1 MiB", async () => {
    const m = machine();
    await FakeAgent.connect(m);
    const { stream } = counted(new Uint8Array(1), 1);
    await expect(relay.relayFetch(m.id, { method: "PUT", path: "/v1/x", headers: {}, body: "x", stream })).rejects.toThrow(TypeError);
    await expect(relay.relayFetch(m.id, { method: "POST", path: "/v1/x", headers: {}, body: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({ status: 413 });
  });

  it("is limited to 8 GiB: that much is taken, the byte after it fails the request", async () => {
    const m = machine();
    const agent = await FakeAgent.connect(m);
    const slab = new Uint8Array(16 * 1024 * 1024); // the same bytes 512 times over: nothing is copied
    const gib8 = 8 * 1024 ** 3;

    const exact = putImage(m, counted(slab, 512).stream);
    const first = await agent.request();
    const reader = (await agent.body(first.id!)).body!.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(gib8);
    await agent.respond(first.id!, 0, { status: 204, end: true });
    expect((await exact).status).toBe(204);

    let sent = 0;
    const tooMuch = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent++;
          controller.enqueue(sent <= 512 ? slab : new Uint8Array(1));
        },
      },
      { highWaterMark: 0 },
    );
    const over = putImage(m, tooMuch).catch((e: unknown) => e);
    const second = await agent.request();
    const overReader = (await agent.body(second.id!)).body!.getReader();
    await expect(
      (async () => {
        for (;;) if ((await overReader.read()).done) return;
      })(),
    ).rejects.toBeDefined();
    expect(await over).toMatchObject({ name: "RelayError", status: 413 });
    expect(sent).toBe(513);
  });

  it("is given only to the machine the request went to, and only if the request has one", async () => {
    const m = machine();
    const other = machine();
    const agent = await FakeAgent.connect(m);
    const { stream } = counted(new Uint8Array(8), 1);
    void putImage(m, stream).catch(() => {});
    const streamed = await agent.request();
    void relay.relayFetch(m.id, GET("/v1/plain")).catch(() => {});
    const plain = await agent.request();

    expect((await agent.body(streamed.id!, { credential: "nope" })).status).toBe(401);
    expect((await agent.body(streamed.id!, { credential: other.credential })).status).toBe(404);
    expect((await agent.body(plain.id!)).status).toBe(404);
    expect((await agent.body("0123456789abcdef")).status).toBe(404);
    // None of that spent the body.
    expect((await agent.body(streamed.id!)).status).toBe(200);
  });
});
