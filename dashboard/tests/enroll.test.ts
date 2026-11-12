import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-enrol-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let signedIn = true;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (!signedIn) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "203.0.113.9" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);

const { enrolServer, redeemEnrolment } = await import("@/lib/enroll");
const { ENROL_PREFIX, enrolParam, parseEnrolment } = await import("@/lib/enroll-core");
const { enrolServerAction } = await import("@/app/server-enrol-actions");
const { db } = await import("@/lib/db");
const servers = await import("@/lib/servers");

// ---- A throwaway PKI, as `keelson-agent install` would lay one out ---------------------------------------------------------

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}
function issue(name: string, usage: "serverAuth" | "clientAuth") {
  openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
  writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=${usage}\n`);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`);
}
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

const TOKEN = "t".repeat(40);
const DEPLOY = "d".repeat(40);
const CODE = Buffer.alloc(24, 7).toString("base64url");

let pki: { ca: string; serverCert: string; serverKey: string; clientCert: string; clientKey: string; fp: string };

beforeAll(() => {
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=test-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE");
  issue("server", "serverAuth");
  issue("client", "clientAuth");
  const serverCert = read("server.crt");
  pki = {
    ca: read("ca.crt"),
    serverCert,
    serverKey: read("server.key"),
    clientCert: read("client.crt"),
    clientKey: read("client.key"),
    fp: createHash("sha256").update(new X509Certificate(serverCert).raw).digest("hex"),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---- A fake agent ----------------------------------------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  body: string;
  clientAuthorized: boolean;
  authorization?: string;
}
let fake: Server | null = null;
let seen: Seen[] = [];
let respond: (req: Seen, res: import("node:http").ServerResponse) => void = () => {};
let otherHits = 0;

const grantBody = () => ({
  ca_pem: pki.ca,
  client_cert_pem: pki.clientCert,
  client_key_pem: pki.clientKey,
  token: TOKEN,
  deploy_secret: DEPLOY,
});
const ok = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

async function startAgent(opts: { maxVersion?: "TLSv1.2"; strictMtls?: boolean } = {}): Promise<string> {
  fake = createServer({ key: pki.serverKey, cert: pki.serverCert, ca: pki.ca, requestCert: true, rejectUnauthorized: opts.strictMtls === true, maxVersion: opts.maxVersion }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString(),
        clientAuthorized: (req.socket as unknown as { authorized: boolean }).authorized,
        authorization: req.headers.authorization,
      };
      if (rec.url === "/other") otherHits++;
      seen.push(rec);
      respond(rec, res);
    });
  });
  await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
  return `https://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}

/** The enrolment string the agent would print. */
const stringFor = (u: string, over: Record<string, unknown> = {}) =>
  ENROL_PREFIX + Buffer.from(JSON.stringify({ u, fp: pki.fp, c: CODE, ...over })).toString("base64url");

const enrolPosts = () => seen.filter((s) => s.method === "POST" && s.url === "/v1/enroll");

/** Answers like a real agent: enrolment for anyone, everything else only with the client certificate and the token. */
function agentBehaviour(req: Seen, res: import("node:http").ServerResponse) {
  if (req.url === "/v1/enroll") return ok(res, 200, grantBody());
  if (!req.clientAuthorized) return ok(res, 401, { error: "client certificate required" });
  if (req.authorization !== `Bearer ${TOKEN}`) return ok(res, 401, { error: "unauthorized" });
  return ok(res, 200, []);
}

afterEach(async () => {
  respond = () => {};
  seen = [];
  otherHits = 0;
  if (fake) {
    fake.closeAllConnections();
    await new Promise((r) => fake!.close(r));
    fake = null;
  }
  db().exec("DELETE FROM servers; DELETE FROM audit_log");
  vi.restoreAllMocks();
});

// ---- Parsing ---------------------------------------------------------------------------------------------------------------

describe("parseEnrolment", () => {
  const u = "https://203.0.113.10:7443";
  it("reads the string the agent prints", () => {
    expect(parseEnrolment(stringFor(u))).toEqual({ url: u, host: "203.0.113.10", fingerprint: pki.fp, code: CODE });
    expect(parseEnrolment(`  ${stringFor("https://agent.example.com/")}\n`).url).toBe("https://agent.example.com");
    expect(parseEnrolment(stringFor("https://[2001:db8::1]:7443")).host).toBe("2001:db8::1");
  });

  it("reads it where there is no Buffer, as in the browser (the form suggests a name from it)", () => {
    const text = stringFor(u);
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(parseEnrolment(text)).toEqual({ url: u, host: "203.0.113.10", fingerprint: pki.fp, code: CODE });
      expect(() => parseEnrolment(`${text}A`)).toThrow(/damaged/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses everything that is not exactly that", () => {
    const raw = (o: unknown) => ENROL_PREFIX + Buffer.from(JSON.stringify(o)).toString("base64url");
    const good = { u, fp: pki.fp, c: CODE };
    const bad: Record<string, string> = {
      "no prefix": stringFor(u).slice(ENROL_PREFIX.length),
      "other prefix": "kse2." + stringFor(u).slice(ENROL_PREFIX.length),
      "empty body": ENROL_PREFIX,
      "bad base64": ENROL_PREFIX + "!!!not base64!!!",
      "padding": stringFor(u) + "==",
      "not json": ENROL_PREFIX + Buffer.from("hello").toString("base64url"),
      "json array": raw([u, pki.fp, CODE]),
      "extra field": raw({ ...good, x: 1 }),
      "missing field": raw({ u, fp: pki.fp }),
      "number code": raw({ ...good, c: 12 }),
      "http url": raw({ ...good, u: "http://203.0.113.10:7443" }),
      "ftp url": raw({ ...good, u: "ftp://203.0.113.10" }),
      "not a url": raw({ ...good, u: "203.0.113.10:7443" }),
      "credentials": raw({ ...good, u: "https://user:pw@203.0.113.10:7443" }),
      "path": raw({ ...good, u: "https://203.0.113.10:7443/v1" }),
      "query": raw({ ...good, u: "https://203.0.113.10:7443?x=1" }),
      "fragment": raw({ ...good, u: "https://203.0.113.10:7443#x" }),
      "short fp": raw({ ...good, fp: pki.fp.slice(1) }),
      "long fp": raw({ ...good, fp: pki.fp + "0" }),
      "upper fp": raw({ ...good, fp: pki.fp.toUpperCase() }),
      "non-hex fp": raw({ ...good, fp: "z".repeat(64) }),
      "empty code": raw({ ...good, c: "" }),
      "code with space": raw({ ...good, c: "a b" }),
      "huge": ENROL_PREFIX + "A".repeat(5000),
    };
    for (const [why, s] of Object.entries(bad)) expect(() => parseEnrolment(s), why).toThrow(/enrolment|address|fingerprint|code|damaged|unexpected/i);
  });

  it("only pre-fills from a link parameter that looks like a string", () => {
    expect(enrolParam(stringFor(u))).toBe(stringFor(u));
    expect(enrolParam(undefined)).toBeUndefined();
    expect(enrolParam([stringFor(u)])).toBeUndefined();
    expect(enrolParam("<script>")).toBeUndefined();
    expect(enrolParam("kse1.<script>")).toBeUndefined();
  });
});

describe("the link never submits", () => {
  const read = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8");
  it("only calls the action from the button's handler", () => {
    const src = read("components/servers/EnrolServer.tsx");
    expect(src).not.toMatch(/useLayoutEffect|requestSubmit|\.submit\(/);
    // The one effect only takes the string out of the address bar.
    expect(src.match(/useEffect\(/g)).toHaveLength(1);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(initial !== ""\) window\.history\.replaceState\([^)]*\);\s*\}, \[initial\]\);/);
    expect(src.match(/enrolServerAction\(/g)).toHaveLength(1);
    // That one call sits in enrol(), which only the button's onClick runs.
    expect(src).toMatch(/function enrol\(\)[\s\S]*?enrolServerAction\([\s\S]*?\n  \}\n/);
    expect(src.match(/onClick=\{enrol\}/g)).toHaveLength(1);
    expect(src).not.toMatch(/<form/);
  });
  it("makes the tab the default only when the link carries a string", () => {
    const src = read("components/servers/AddServerTabs.tsx");
    expect(src).toContain('defaultValue={enrol ? "enrol" : "ssh"}');
    expect(read("app/(app)/servers/new/page.tsx")).toContain("enrolParam(q.enrol)");
  });
});

// ---- Redeeming: pinning, TLS, redirects, timeouts ----------------------------------------------------------------------------

describe("redeemEnrolment", () => {
  it("sends the code once to an agent whose certificate matches, and returns what it hands over", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toEqual({ ok: true, grant: { caCert: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey, token: TOKEN, deploySecret: DEPLOY } });
    expect(enrolPosts()).toHaveLength(1);
    expect(JSON.parse(enrolPosts()[0].body)).toEqual({ code: CODE });
    expect(enrolPosts()[0].clientAuthorized).toBe(false);
  });

  it("accepts an agent without a deploy secret", async () => {
    respond = (_r, res) => ok(res, 200, { ...grantBody(), deploy_secret: "" });
    const url = await startAgent();
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toMatchObject({ ok: true, grant: { deploySecret: "" } });
  });

  it("refuses a different certificate before sending anything, the code included", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    const r = await redeemEnrolment(parseEnrolment(stringFor(url, { fp: "0".repeat(64) })));
    expect(r).toMatchObject({ ok: false, kind: "fingerprint" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a server that cannot do TLS 1.3", async () => {
    respond = agentBehaviour;
    const url = await startAgent({ maxVersion: "TLSv1.2" });
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toMatchObject({ ok: false, kind: "tls" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a redirect and does not follow it", async () => {
    const url = await startAgent();
    respond = (_r, res) => {
      res.writeHead(307, { location: `${url}/other` });
      res.end();
    };
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toMatchObject({ ok: false, kind: "redirect" });
    expect(otherHits).toBe(0);
    expect(enrolPosts()).toHaveLength(1);
  });

  it("gives up when the agent does not answer", async () => {
    respond = () => {}; // never answers
    const url = await startAgent();
    const t0 = Date.now();
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)), 300);
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("explains an agent that asks for a client certificate and has no enrolment (it hangs up after the handshake)", async () => {
    const url = await startAgent({ strictMtls: true });
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toMatchObject({ ok: false, kind: "not_enabled", message: expect.stringMatching(/client certificate and has no enrolment.*install --upgrade/) });
    expect(seen).toHaveLength(0);
  });

  it("says so when nothing listens", async () => {
    const url = await startAgent();
    await new Promise((r) => fake!.close(r));
    fake = null;
    const r = await redeemEnrolment(parseEnrolment(stringFor(url)));
    expect(r).toMatchObject({ ok: false, kind: "unreachable", message: expect.stringContaining("refused") });
  });

  it("maps each answer of the agent to a clear message", async () => {
    const url = await startAgent();
    const run = async () => redeemEnrolment(parseEnrolment(stringFor(url)));
    const cases: [number, Record<string, string>, unknown, string, RegExp][] = [
      [400, {}, { error: "bad" }, "malformed", /malformed/],
      [403, {}, { error: "invalid or expired code" }, "invalid_code", /invalid, expired or already used/],
      [404, {}, { error: "not found" }, "not_enabled", /not enabled/],
      [429, { "retry-after": "42" }, { error: "slow down" }, "rate_limited", /42 s/],
      [429, {}, {}, "rate_limited", /a minute/],
      [500, {}, { error: "boom" }, "agent", /500/],
    ];
    for (const [status, headers, body, kind, message] of cases) {
      respond = (_r, res) => ok(res, status, body, headers);
      expect(await run(), String(status)).toMatchObject({ ok: false, kind, message: expect.stringMatching(message) });
    }
  });

  it("refuses answers that are not a complete grant", async () => {
    const url = await startAgent();
    const bad: unknown[] = [
      {},
      { ...grantBody(), ca_pem: "nope" },
      { ...grantBody(), client_key_pem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" },
      { ...grantBody(), token: "short" },
      { ...grantBody(), deploy_secret: "short" },
      { ...grantBody(), deploy_secret: TOKEN },
      { ...grantBody(), token: 5 },
    ];
    for (const body of bad) {
      respond = (_r, res) => ok(res, 200, body);
      expect(await redeemEnrolment(parseEnrolment(stringFor(url))), JSON.stringify(body).slice(0, 40)).toMatchObject({ ok: false, kind: "agent" });
    }
    respond = (_r, res) => {
      res.writeHead(200);
      res.end("not json");
    };
    expect(await redeemEnrolment(parseEnrolment(stringFor(url)))).toMatchObject({ ok: false, kind: "agent" });
  });

  it("does not read an unbounded answer", async () => {
    const url = await startAgent();
    respond = (_r, res) => {
      res.writeHead(200);
      res.end("x".repeat(200_000));
    };
    expect(await redeemEnrolment(parseEnrolment(stringFor(url)))).toMatchObject({ ok: false });
  });
});

// ---- The whole enrolment -----------------------------------------------------------------------------------------------------

describe("enrolServer", () => {
  it("verifies the agent with what it received, then stores everything encrypted", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    const input = stringFor(url);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];

    const r = await enrolServer(input, "", "203.0.113.9");
    expect(r).toEqual({ ok: true, serverId: expect.any(String), name: "127.0.0.1", deployable: true });

    // Verified with the new credentials: mutual TLS and the bearer token.
    const probe = seen.find((s) => s.url.startsWith("/v1/containers"));
    expect(probe).toMatchObject({ clientAuthorized: true, authorization: `Bearer ${TOKEN}` });

    const creds = servers.getCredentials((r as { serverId: string }).serverId)!;
    expect(creds).toMatchObject({ url, token: TOKEN, deploySecret: DEPLOY, caCert: pki.ca.trim(), clientCert: pki.clientCert.trim(), clientKey: pki.clientKey.trim() });
    expect(servers.getServer(creds.id)!.canDeploy).toBe(true);

    // Secrets are encrypted at rest.
    const raw = JSON.stringify(db().prepare("SELECT * FROM servers").all());
    for (const secret of [TOKEN, DEPLOY, pki.clientKey, pki.clientKey.split("\n")[1]]) expect(raw).not.toContain(secret);

    // Neither the string, the code nor any secret reaches the audit trail, the logs or the answer.
    const everywhere = JSON.stringify([db().prepare("SELECT * FROM audit_log").all(), logs.map((l) => l.mock.calls), r]);
    for (const leaked of [input, CODE, TOKEN, DEPLOY, "PRIVATE KEY", pki.fp]) expect(everywhere, leaked).not.toContain(leaked);
    expect(db().prepare("SELECT * FROM audit_log WHERE event = 'server_enrol'").all()).toEqual([expect.objectContaining({ ip: "203.0.113.9" })]);
    // The string is stored nowhere in the database.
const tables = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const dump = JSON.stringify(tables.map((t) => db().prepare(`SELECT * FROM "${t.name}"`).all()));
    expect(dump).not.toContain(CODE);
  });

  it("registers a read-only server when the agent has no deploy secret", async () => {
    respond = (req, res) => (req.url === "/v1/enroll" ? ok(res, 200, { ...grantBody(), deploy_secret: "" }) : agentBehaviour(req, res));
    const url = await startAgent();
    const r = await enrolServer(stringFor(url), "ro", "x");
    expect(r).toMatchObject({ ok: true, deployable: false });
    expect(servers.getServer((r as { serverId: string }).serverId)!.canDeploy).toBe(false);
  });

  it("applies the add-server name rules, before the one-time code is spent", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    servers.createServer({ name: "taken", url: "https://x.example.com", token: TOKEN });
    expect(await enrolServer(stringFor(url), "taken", "x")).toMatchObject({ ok: false, field: "name" });
    expect(await enrolServer(stringFor(url), "bad;name", "x")).toMatchObject({ ok: false, field: "name" });
    expect(await enrolServer(stringFor(url), "x".repeat(70), "x")).toMatchObject({ ok: false, field: "name" });
    expect(seen).toHaveLength(0);
  });

  it("applies the add-server address rules: https only, no credentials or path", async () => {
    for (const u of ["http://127.0.0.1:1", "https://u:p@127.0.0.1:1", "https://127.0.0.1:1/x"]) {
      expect(await enrolServer(stringFor(u), "", "x"), u).toMatchObject({ ok: false, field: "string", kind: "format" });
    }
  });

  it("saves nothing when the fingerprint differs", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    const r = await enrolServer(stringFor(url, { fp: "f".repeat(64) }), "n", "x");
    expect(r).toMatchObject({ ok: false, kind: "fingerprint" });
    expect(seen).toHaveLength(0);
    expect(servers.listServers()).toHaveLength(0);
  });

  it.each([
    [403, "invalid_code"],
    [404, "not_enabled"],
    [429, "rate_limited"],
  ])("saves nothing when the agent answers %i", async (status, kind) => {
    respond = (_r, res) => ok(res, status, { error: "x" });
    const url = await startAgent();
    expect(await enrolServer(stringFor(url), "n", "x")).toMatchObject({ ok: false, kind });
    expect(servers.listServers()).toHaveLength(0);
  });

  it("saves nothing when the agent does not answer with what it handed over", async () => {
    respond = (req, res) => (req.url === "/v1/enroll" ? ok(res, 200, grantBody()) : ok(res, 401, { error: "no" }));
    const url = await startAgent();
    const r = await enrolServer(stringFor(url), "n", "x");
    expect(r).toMatchObject({ ok: false, kind: "verify", message: expect.stringContaining("run the command on the server again") });
    expect(servers.listServers()).toHaveLength(0);
    expect(db().prepare("SELECT * FROM audit_log WHERE event = 'server_enrol'").all()).toHaveLength(0);
  });

  it("is reachable only with a session", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    signedIn = false;
    try {
      await expect(enrolServerAction(stringFor(url), "n")).rejects.toThrow("NO_SESSION");
    } finally {
      signedIn = true;
    }
    expect(seen).toHaveLength(0);
    const r = await enrolServerAction(stringFor(url), "via-action");
    expect(r).toMatchObject({ ok: true });
  });

  it("is refused until the session is unlocked: the agent is not even contacted and the code is not spent", async () => {
    respond = agentBehaviour;
    const url = await startAgent();
    state.locked = true;
    try {
      const r = await enrolServerAction(stringFor(url), "locked");
      expect(r.ok).toBe(false);
      expect(!r.ok && isStepUpError(r.message)).toBe(true);
      expect(seen).toHaveLength(0);
      expect(servers.listServers().some((s) => s.name === "locked")).toBe(false);
    } finally {
      resetStepUp();
    }
    expect(await enrolServerAction(stringFor(url), "unlocked")).toMatchObject({ ok: true });
  });
});
