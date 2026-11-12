import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyView } from "@/lib/agent-types";
import type { CertProbe, GetProbe, ResolveFacts } from "@/lib/domain-status-core";
import { FakeCloudflare } from "./fake-cloudflare";
import { isStepUpError } from "@/lib/gate-core";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-domain-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

let anonymous = false;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (anonymous) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);

const agent = { view: null as ProxyView | null };
vi.mock("@/lib/agent", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/agent")>()),
  agentFor: () => ({ proxy: async () => agent.view }),
}));

const net = {
  calls: [] as string[],
  resolved: { ok: true, addresses: ["203.0.113.7"] } as ResolveFacts,
  cert: { kind: "no_cert", message: "alert" } as CertProbe,
  get: { kind: "error", message: "x" } as GetProbe,
};
vi.mock("@/lib/domain-probe", () => ({
  resolveAll: async () => ["203.0.113.7"],
  resolveHost: async (host: string) => (net.calls.push(`resolve ${host}`), net.resolved),
  probeCertificate: async (ip: string, host: string) => (net.calls.push(`cert ${ip} ${host}`), net.cert),
  fetchHttps: async (host: string) => (net.calls.push(`get ${host}`), net.get),
}));

const { db } = await import("@/lib/db");
const actions = await import("@/app/domain-actions");
const integrations = await import("@/lib/integrations");
const servers = await import("@/lib/servers");
const store = await import("@/lib/auth/store");

const PASSWORD = "operator-password-1";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

let cf: FakeCloudflare;
let publicServer = "";
let localServer = "";
beforeAll(() => {
  publicServer = servers.createServer({ name: "prod", url: "https://203.0.113.7:8443", token: "t".repeat(40), deploySecret: "s".repeat(40) });
  localServer = servers.createServer({ name: "dev", url: "http://127.0.0.1:8443", token: "t".repeat(40) });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const table of ["audit_log", "integrations", "login_failures"]) db().exec(`DELETE FROM ${table}`);
  anonymous = false;
  resetStepUp();
  net.calls.length = 0;
  net.resolved = { ok: true, addresses: ["203.0.113.7"] };
  agent.view = {
    type: "caddy",
    where: "http://127.0.0.1:2019",
    generated: "{}",
    in_sync: true,
    routes: [{ kind: "app", app: "shop", domains: ["shop.example.com"], upstream: "127.0.0.1:41000", container: "c", ref: "r", updated_at: "2026-10-23T11:00:00Z", running: true }],
    unrouted: [],
  };
  cf = new FakeCloudflare();
  cf.addZone("example.com");
  cf.addZone("example.org");
  vi.stubGlobal("fetch", cf.fetch);
});

const audits = () => store.recentAudit(100);

describe("connecting Cloudflare", () => {
  it("needs the password again: a wrong or missing one stores nothing and asks Cloudflare nothing", async () => {
    expect(await actions.connectCloudflareAction({}, form({ token: cf.token, password: "wrong" }))).toEqual({ error: "Wrong password." });
    expect(await actions.connectCloudflareAction({}, form({ token: cf.token }))).toEqual({ error: "Enter your current password to confirm." });
    expect(integrations.cloudflareSummary()).toBeNull();
    expect(cf.calls).toEqual([]);
  });

  it("checks the token with Cloudflare, lists its zones, stores it encrypted, and answers without it", async () => {
    const out = await actions.connectCloudflareAction({}, form({ token: ` ${cf.token} `, password: PASSWORD }));
    expect(out).toEqual({ ok: true });
    expect(cf.calls.map((c) => c.path)).toEqual(["/user/tokens/verify", "/zones"]);
    expect(integrations.cloudflareSummary()).toMatchObject({ tokenId: "tok-0001", expiresOn: "2027-01-01T00:00:00Z" });
    const row = db().prepare("SELECT token_enc, account FROM integrations WHERE provider = 'cloudflare'").get() as { token_enc: string; account: string };
    expect(row.token_enc).not.toContain(cf.token);
    expect(row.account).not.toContain(cf.token);
    expect(integrations.cloudflareToken()).toBe(cf.token);
  });

  it("audits the connection with the number of zones and never the token", async () => {
    await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));
    const entry = audits().find((a) => a.event === "cloudflare_connected");
    expect(entry?.detail).toBe("2 zone(s), token tok-0001");
    expect(JSON.stringify(audits())).not.toContain(cf.token);
  });

  it("keeps the token out of the database file, its write-ahead log and everything the action returned", async () => {
    const results = [
      await actions.connectCloudflareAction({}, form({ token: cf.token, password: "wrong" })),
      await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD })),
      await actions.connectCloudflareAction({}, form({ token: "x".repeat(50), password: PASSWORD })),
    ];
    expect(JSON.stringify(results)).not.toContain(cf.token);
    for (const file of readdirSync(dir)) expect(readFileSync(path.join(dir, file)).includes(cf.token), file).toBe(false);
  });

  it("refuses a token Cloudflare does not accept, with its message, and stores nothing", async () => {
    const out = await actions.connectCloudflareAction({}, form({ token: "z".repeat(40), password: PASSWORD }));
    expect(out.error).toMatch(/did not accept this token/);
    expect(out.error).not.toContain("z".repeat(40));
    expect(integrations.cloudflareSummary()).toBeNull();
    expect(audits().some((a) => a.event === "cloudflare_connected")).toBe(false);
  });

  it("refuses a valid token that sees no zone, and one that lacks the Zone Read permission, saying which", async () => {
    cf.zones = [];
    expect((await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }))).error).toMatch(/sees no zone/);
    cf.addZone("example.com");
    cf.can.zonesRead = false;
    expect((await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }))).error).toContain("Zone → Zone → Read");
    expect(integrations.cloudflareSummary()).toBeNull();
  });

  it("refuses text that is not a token without asking Cloudflare", async () => {
    expect((await actions.connectCloudflareAction({}, form({ token: "has space inside", password: PASSWORD }))).error).toMatch(/does not look like/);
    expect((await actions.connectCloudflareAction({}, form({ token: "a".repeat(300), password: PASSWORD }))).error).toMatch(/does not look like/);
    expect((await actions.connectCloudflareAction({}, form({ token: "  ", password: PASSWORD }))).error).toBe("Paste the API token.");
    expect(cf.calls).toEqual([]);
  });

  it("replaces the token, again after the password, and keeps the old one if the new one is refused", async () => {
    await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));
    const before = integrations.cloudflareToken();
    expect((await actions.connectCloudflareAction({}, form({ token: "n".repeat(40), password: PASSWORD }))).error).toBeDefined();
    expect(integrations.cloudflareToken()).toBe(before);
    cf.token = "second-token-0123456789abcdef";
    expect(await actions.connectCloudflareAction({}, form({ token: cf.token }))).toEqual({ error: "Enter your current password to confirm." });
    expect(await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }))).toEqual({ ok: true });
    expect(integrations.cloudflareToken()).toBe("second-token-0123456789abcdef");
  });

  it("counts a wrong password against the sign-in throttle", async () => {
    for (let i = 0; i < 5; i++) await actions.connectCloudflareAction({}, form({ token: cf.token, password: "wrong" }));
    expect((await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }))).error).toMatch(/Too many failed attempts/);
    expect(integrations.cloudflareSummary()).toBeNull();
  });

  it("is refused without a session, before anything else", async () => {
    anonymous = true;
    await expect(actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }))).rejects.toThrow("NO_SESSION");
    await expect(actions.disconnectCloudflareAction({}, form({ password: PASSWORD }))).rejects.toThrow("NO_SESSION");
    expect(cf.calls).toEqual([]);
    expect(integrations.cloudflareSummary()).toBeNull();
  });
});

describe("disconnecting Cloudflare", () => {
  beforeEach(async () => {
    await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));
  });

  it("needs the password: a wrong one leaves the token where it is", async () => {
    expect(await actions.disconnectCloudflareAction({}, form({ password: "wrong" }))).toEqual({ error: "Wrong password." });
    expect(integrations.cloudflareToken()).toBe(cf.token);
  });

  it("removes the token and audits it", async () => {
    expect(await actions.disconnectCloudflareAction({}, form({ password: PASSWORD }))).toEqual({ ok: true });
    expect(integrations.cloudflareToken()).toBeNull();
    expect(integrations.cloudflareSummary()).toBeNull();
    expect(audits().some((a) => a.event === "cloudflare_disconnected")).toBe(true);
  });
});

describe("checking a domain", () => {
  it("needs a session", async () => {
    anonymous = true;
    await expect(actions.checkDomainAction(publicServer, "shop.example.com")).rejects.toThrow("NO_SESSION");
    expect(net.calls).toEqual([]);
  });

  it("refuses an unknown server and anything that is not a host name, without probing", async () => {
    expect(await actions.checkDomainAction("nope", "shop.example.com")).toEqual({ ok: false, error: "Unknown server." });
    for (const host of ["203.0.113.7", "127.0.0.1", "[::1]", "", "localhost", "a b.example.com"]) {
      expect(await actions.checkDomainAction(publicServer, host), host).toEqual({ ok: false, error: "That is not a host name." });
    }
    expect(net.calls).toEqual([]);
  });

  it("probes a declared host at the server's address, and returns the three checks", async () => {
    net.cert = { kind: "no_cert", message: "alert" };
    const out = await actions.checkDomainAction(publicServer, "Shop.Example.com");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.status.hostname).toBe("shop.example.com");
    expect(out.status.dns.state).toBe("ok");
    expect(out.status.proxy.state).toBe("ok");
    expect(out.status.https.state).toBe("pending");
    expect(net.calls).toContain("cert 203.0.113.7 shop.example.com");
  });

  it("does not probe a host the agent does not declare, the SSRF guard being server-side", async () => {
    const out = await actions.checkDomainAction(publicServer, "intranet.example.com");
    expect(out.ok && out.status.proxy.state).toBe("failed");
    expect(net.calls).toEqual([]);
    expect(cf.calls).toEqual([]);
  });

  it("asks Cloudflare for the record when connected, and compares a proxied record's content", async () => {
    await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));
    cf.addRecord("example.com", { type: "A", name: "shop.example.com", content: "203.0.113.7", proxied: true });
    net.resolved = { ok: true, addresses: ["104.21.55.9"] };
    cf.calls.length = 0;
    const out = await actions.checkDomainAction(publicServer, "shop.example.com");
    expect(out.ok && out.status.cloudflare).toBe("connected");
    expect(out.ok && out.status.dns).toMatchObject({ state: "ok", detail: expect.stringContaining("proxied") });
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("falls back to the resolver, and says why, when Cloudflare cannot be read", async () => {
    await actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));
    cf.rateLimit = 5;
    const out = await actions.checkDomainAction(publicServer, "shop.example.com");
    expect(out.ok && out.status).toMatchObject({ cloudflare: "error", cloudflareError: expect.stringContaining("request limit"), dns: { state: "ok" } });
  });
});

describe("pointing a domain at the server", () => {
  const connect = () => actions.connectCloudflareAction({}, form({ token: cf.token, password: PASSWORD }));

  it("needs a session", async () => {
    anonymous = true;
    await expect(actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true })).rejects.toThrow("NO_SESSION");
    expect(cf.calls).toEqual([]);
  });

  describe("when the session is not unlocked", () => {
    beforeEach(async () => {
      await connect();
      state.locked = true;
    });

    it("still creates the record of a host name the agent declares, where there is none yet", async () => {
      const out = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
      expect(out.result.kind).toBe("created");
      expect(cf.writes).toHaveLength(1);
    });

    it("refuses to replace a record, and writes nothing: the confirmation alone is not enough", async () => {
      cf.addRecord("example.com", { type: "A", name: "shop.example.com", content: "198.51.100.9" });
      const conflict = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
      expect(conflict.result.kind).toBe("conflict");
      const out = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true, confirmReplace: "A 198.51.100.9" });
      expect(out.result.kind).toBe("failed");
      expect(isStepUpError(out.message)).toBe(true);
      expect(cf.writes).toEqual([]);
      state.locked = false;
      expect((await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true, confirmReplace: "A 198.51.100.9" })).result.kind).toBe("replaced");
    });

    it("refuses a host name the server does not declare, even where there is no record", async () => {
      const out = await actions.ensureDnsAction(publicServer, "victim.example.com", { proxied: true });
      expect(out.result.kind).toBe("failed");
      expect(isStepUpError(out.message)).toBe(true);
      expect(cf.writes).toEqual([]);
    });

    it("treats an agent that cannot say what it declares as declaring nothing", async () => {
      agent.view = null;
      const out = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
      expect(isStepUpError(out.message)).toBe(true);
      expect(cf.writes).toEqual([]);
    });
  });

  it("says Cloudflare is not connected, and writes nothing, without a token", async () => {
    const out = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
    expect(out.result.kind).toBe("not_connected");
    expect(out.message).toMatch(/not connected/);
    expect(cf.calls).toEqual([]);
  });

  it("creates the record at the server's address, proxied, and audits it with the server and without the token", async () => {
    await connect();
    const out = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
    expect(out.result).toMatchObject({ kind: "created", zone: "example.com", record: { type: "A", content: "203.0.113.7", proxied: true } });
    expect(out.message).toBe("Created A shop.example.com -> 203.0.113.7, proxied (zone example.com).");
    expect(cf.writes[0]).toMatchObject({ body: { type: "A", name: "shop.example.com", content: "203.0.113.7", proxied: true, ttl: 1 } });
    const entry = audits().find((a) => a.event === "dns_record_created");
    expect(entry?.detail).toBe("prod: shop.example.com (zone example.com): A shop.example.com -> 203.0.113.7, proxied");
    expect(JSON.stringify([out, audits()])).not.toContain(cf.token);
  });

  it("does it twice without a second write, and creates a DNS-only record when asked", async () => {
    await connect();
    await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: false });
    const again = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: false });
    expect(again.result.kind).toBe("exists");
    expect(cf.writes).toHaveLength(1);
    expect(cf.records[0]).toMatchObject({ proxied: false });
  });

  it("asks before replacing a record, naming it, and replaces only on the exact confirmation", async () => {
    await connect();
    cf.addRecord("example.com", { type: "A", name: "shop.example.com", content: "198.51.100.9" });
    const asked = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true });
    expect(asked.result).toMatchObject({ kind: "conflict", confirm: "A 198.51.100.9" });
    expect(asked.message).toContain("A 198.51.100.9");
    expect(cf.writes).toEqual([]);
    const wrong = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true, confirmReplace: "A 1.1.1.1" });
    expect(wrong.result.kind).toBe("conflict");
    const done = await actions.ensureDnsAction(publicServer, "shop.example.com", { proxied: true, confirmReplace: "A 198.51.100.9" });
    expect(done.result.kind).toBe("replaced");
    expect(audits().find((a) => a.event === "dns_record_replaced")?.detail).toContain("was A 198.51.100.9, now A shop.example.com -> 203.0.113.7, proxied");
  });

  it("refuses a loopback server address, and creates the record only with the operator's confirmation", async () => {
    await connect();
    const refused = await actions.ensureDnsAction(localServer, "dev.example.com", { proxied: true });
    expect(refused.result).toMatchObject({ kind: "private", ip: "127.0.0.1" });
    expect(refused.message).toMatch(/loopback/);
    expect(cf.writes).toEqual([]);
    const allowed = await actions.ensureDnsAction(localServer, "dev.example.com", { proxied: true, allowPrivate: true });
    expect(allowed.result).toMatchObject({ kind: "created", record: { content: "127.0.0.1" } });
    expect(audits().find((a) => a.event === "dns_record_created")?.detail).toContain("[private address confirmed]");
  });

  it("uses the server's public address when one is set, instead of the private one in its URL", async () => {
    await connect();
    servers.updateServer(localServer, { name: "dev", url: "http://127.0.0.1:8443", caCert: "", clientCert: "", publicIp: "198.51.100.20" });
    const out = await actions.ensureDnsAction(localServer, "dev.example.com", { proxied: true });
    expect(out.result).toMatchObject({ kind: "created", record: { content: "198.51.100.20" } });
    servers.updateServer(localServer, { name: "dev", url: "http://127.0.0.1:8443", caCert: "", clientCert: "", publicIp: "" });
  });

  it("makes a proxied record unless the client says exactly false, and allows a private address only on exactly true", async () => {
    await connect();
    const out = await actions.ensureDnsAction(publicServer, "shop.example.com", {} as unknown as { proxied: boolean });
    expect(out.result).toMatchObject({ kind: "created", record: { proxied: true } });
    const refused = await actions.ensureDnsAction(localServer, "dev.example.com", { proxied: true, allowPrivate: "true" as unknown as boolean });
    expect(refused.result.kind).toBe("private");
  });

  it("says when no zone covers the host, and for an unknown server", async () => {
    await connect();
    expect((await actions.ensureDnsAction(publicServer, "shop.unknown.net", { proxied: true })).result.kind).toBe("no_zone");
    expect((await actions.ensureDnsAction("nope", "shop.example.com", { proxied: true })).result).toEqual({ kind: "failed", message: "Unknown server." });
  });
});
