import { describe, expect, it } from "vitest";
import type { ProxyView } from "@/lib/agent-types";
import { checkDomain, type Probes } from "@/lib/domains";
import type { CertProbe, CloudflareFacts, GetProbe, ResolveFacts } from "@/lib/domain-status-core";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const DAY = 86_400_000;
const HOST = "app.example.com";

const view = (over: Partial<ProxyView> = {}): ProxyView => ({
  type: "caddy",
  where: "http://127.0.0.1:2019",
  generated: "{}",
  in_sync: true,
  routes: [{ kind: "app", app: "shop", domains: [HOST], upstream: "127.0.0.1:41000", container: "c", ref: "r", updated_at: "2026-10-23T11:00:00Z", running: true }],
  unrouted: [],
  ...over,
});
const agent = (v: ProxyView | null | Error = view()) => ({
  proxy: async () => {
    if (v instanceof Error) throw v;
    return v;
  },
});

const goodCert: CertProbe = { kind: "cert", issuer: "Let's Encrypt R11", names: [HOST], validFrom: NOW - DAY, validTo: NOW + 60 * DAY, matches: true, trusted: true };

/** Probes that record every call, so that a test can say what was NOT touched. */
function probes(over: { resolved?: ResolveFacts; cloudflare?: CloudflareFacts; cert?: CertProbe; get?: GetProbe } = {}) {
  const calls: string[] = [];
  const p: Probes = {
    async resolve(host) {
      calls.push(`resolve ${host}`);
      return over.resolved ?? { ok: true, addresses: ["203.0.113.7"] };
    },
    async cloudflare(host) {
      calls.push(`cloudflare ${host}`);
      return over.cloudflare ?? { state: "off" };
    },
    async cert(ip, host) {
      calls.push(`cert ${ip} ${host}`);
      return over.cert ?? goodCert;
    },
    async get(host) {
      calls.push(`get ${host}`);
      return over.get ?? { kind: "status", status: 200 };
    },
    now: () => NOW,
  };
  return { p, calls };
}

const SERVER = { url: "https://203.0.113.7:8443", publicIp: null };

describe("checkDomain", () => {
  it("checks a declared host: resolves it, asks Cloudflare, probes the certificate at the server's address and fetches it", async () => {
    const { p, calls } = probes();
    const status = await checkDomain(SERVER, agent(), HOST, p);
    expect(calls.sort()).toEqual([`cert 203.0.113.7 ${HOST}`, `cloudflare ${HOST}`, `get ${HOST}`, `resolve ${HOST}`].sort());
    expect([status.dns.state, status.proxy.state, status.https.state]).toEqual(["ok", "ok", "ok"]);
    expect(status.expected).toEqual({ type: "A", ip: "203.0.113.7", source: "agent-url" });
  });

  it("connects to the server's explicit public address, not to the one in the agent's URL, and never to anything typed", async () => {
    const { p, calls } = probes();
    await checkDomain({ url: "https://10.0.0.5:8443", publicIp: "198.51.100.20" }, agent(), HOST, p);
    expect(calls.filter((c) => c.startsWith("cert"))).toEqual([`cert 198.51.100.20 ${HOST}`]);
  });

  it("probes an IPv6 server at its IPv6 address", async () => {
    const { p, calls } = probes();
    const status = await checkDomain({ url: "https://[2001:db8::7]:8443", publicIp: null }, agent(), HOST, p);
    expect(calls).toContain(`cert 2001:db8::7 ${HOST}`);
    expect(status.expected).toMatchObject({ type: "AAAA", ip: "2001:db8::7" });
  });

  it("touches nothing at all for a host the agent does not declare, and says it is not declared", async () => {
    const { p, calls } = probes();
    const status = await checkDomain(SERVER, agent(), "internal.corp.example", p);
    expect(calls).toEqual([]);
    expect(status.proxy).toMatchObject({ state: "failed", detail: expect.stringContaining("not declared") });
    expect(status.dns.state).toBe("skipped");
    expect(status.https.state).toBe("skipped");
  });

  it("touches nothing for an IP literal, however it is written, even when the agent declares it", async () => {
    const declared = view({ routes: [{ kind: "site", app: "", domains: ["127.0.0.1", "169.254.169.254", "[::1]", "10.0.0.1"], upstream: "", container: "", ref: "", updated_at: "", running: false }] });
    for (const host of ["127.0.0.1", "169.254.169.254", "[::1]", "::1", "10.0.0.1", "0x7f000001", "localhost"]) {
      const { p, calls } = probes();
      const status = await checkDomain(SERVER, agent(declared), host, p);
      expect(calls, host).toEqual([]);
      expect(status.https.state, host).toBe("skipped");
    }
  });

  it("touches nothing when the agent cannot be asked: what it declares is unknown, so nothing is declared", async () => {
    const { p, calls } = probes();
    const status = await checkDomain(SERVER, agent(new Error("agent unreachable")), HOST, p);
    expect(calls).toEqual([]);
    expect(status.proxy).toMatchObject({ state: "failed", detail: expect.stringContaining("agent unreachable") });
  });

  it("touches nothing for an agent without a proxy", async () => {
    const { p, calls } = probes();
    const status = await checkDomain(SERVER, agent(null), HOST, p);
    expect(calls).toEqual([]);
    expect(status.proxy.detail).toContain("no reverse proxy");
  });

  it("probes a name only an app still waiting for its route declares", async () => {
    const { p, calls } = probes({ cert: { kind: "no_cert", message: "alert" }, get: { kind: "error", message: "x" } });
    const status = await checkDomain(SERVER, agent(view({ routes: [], unrouted: [{ app: "shop", domains: [HOST], reason: "no deployment yet" }] })), HOST, p);
    expect(calls).toContain(`cert 203.0.113.7 ${HOST}`);
    expect(status.proxy.state).toBe("pending");
    expect(status.https.state).toBe("pending");
  });

  it("does not probe the certificate when the server's address cannot be known, and says how to fix it", async () => {
    const { p, calls } = probes();
    const status = await checkDomain({ url: "https://203.0.113.7", publicIp: "not-an-ip" }, agent(), HOST, p);
    expect(calls.some((c) => c.startsWith("cert") || c.startsWith("get"))).toBe(false);
    expect(status.dns).toMatchObject({ state: "skipped", next: expect.stringContaining("settings") });
    expect(status.https.state).toBe("skipped");
  });

  it("uses what Cloudflare says about a proxied record instead of the resolved addresses", async () => {
    const { p } = probes({
      resolved: { ok: true, addresses: ["104.21.55.9"] },
      cloudflare: { state: "ok", zone: "example.com", records: [{ id: "r1", type: "A", name: HOST, content: "203.0.113.7", proxied: true, ttl: 1 }] },
    });
    const status = await checkDomain(SERVER, agent(), HOST, p);
    expect(status.dns.state).toBe("ok");
    expect(status.dns.detail).toContain("proxied");
    expect(status.cloudflare).toBe("connected");
  });

  it("reports Caddy's internal certificate as not publicly trusted, not as OK", async () => {
    const { p } = probes({
      cert: { kind: "cert", issuer: "Caddy Local Authority - ECC Intermediate", names: [HOST], validFrom: NOW - DAY, validTo: NOW + DAY, matches: true, trusted: false, trustError: "SELF_SIGNED_CERT_IN_CHAIN" },
      get: { kind: "error", message: "the certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN)" },
    });
    const status = await checkDomain(SERVER, agent(), HOST, p);
    expect(status.https.state).toBe("failed");
    expect(status.https.detail).toContain("Caddy Local Authority - ECC Intermediate, not publicly trusted");
  });
});
