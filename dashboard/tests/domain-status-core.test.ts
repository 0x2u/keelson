import { describe, expect, it } from "vitest";
import type { ProxyRoute, ProxyView } from "@/lib/agent-types";
import type { CfRecord } from "@/lib/cloudflare-core";
import {
  assembleStatus,
  declaredHostnames,
  evaluateDns,
  evaluateHttps,
  evaluateProxy,
  expectedOf,
  span,
  hostsOf,
  overall,
  pollDelay,
  probeTarget,
  POLL_LIMIT_MS,
  type CertProbe,
  type CloudflareFacts,
  type DomainStatus,
  type ExpectedAddress,
  type StatusFacts,
} from "@/lib/domain-status-core";

const HOST = "app.example.com";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const DAY = 86_400_000;
const EXPECTED: ExpectedAddress = { type: "A", ip: "203.0.113.7", source: "agent-url" };

const cfRecord = (over: Partial<CfRecord> = {}): CfRecord => ({ id: "r1", type: "A", name: HOST, content: "203.0.113.7", proxied: false, ttl: 1, ...over });
const cf = (...records: CfRecord[]): CloudflareFacts => ({ state: "ok", zone: "example.com", records });
const OFF: CloudflareFacts = { state: "off" };
const answers = (...addresses: string[]) => ({ ok: true as const, addresses });
const NONE = { ok: false as const, reason: "none" as const };

const route = (over: Partial<ProxyRoute> = {}): ProxyRoute => ({ kind: "app", app: "shop", domains: [HOST], upstream: "127.0.0.1:41000", container: "shop-1", ref: "img:1", updated_at: "2026-10-23T11:00:00Z", running: true, ...over });
const view = (over: Partial<ProxyView> = {}): ProxyView => ({ type: "caddy", where: "http://127.0.0.1:2019", generated: "{}", in_sync: true, routes: [route()], unrouted: [], ...over });

const validCert = (over: Partial<Extract<CertProbe, { kind: "cert" }>> = {}): CertProbe => ({
  kind: "cert",
  issuer: "Let's Encrypt R11",
  names: [HOST],
  validFrom: NOW - 30 * DAY,
  validTo: NOW + 60 * DAY,
  matches: true,
  trusted: true,
  ...over,
});
const https = (over: Partial<Parameters<typeof evaluateHttps>[0]> = {}) =>
  evaluateHttps({ hostname: HOST, expected: EXPECTED, declared: true, cert: validCert(), get: { kind: "status", status: 200 }, dnsOk: true, proxied: false, now: NOW, ...over });

describe("the DNS check", () => {
  it("is skipped, and says how to fix it, when the server's address is not known", () => {
    const c = evaluateDns(HOST, null, answers("203.0.113.7"), OFF);
    expect(c.state).toBe("skipped");
    expect(c.next).toMatch(/server's settings/);
  });

  it("is OK when the name resolves to the server", () => {
    const c = evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), OFF);
    expect(c).toEqual({ state: "ok", detail: "app.example.com resolves to the server (203.0.113.7)." });
  });

  it("notes the other addresses when the server is only one of them", () => {
    const c = evaluateDns(HOST, EXPECTED, answers("203.0.113.7", "2001:db8::9"), OFF);
    expect(c.state).toBe("ok");
    expect(c.detail).toContain("also to 2001:db8::9");
  });

  it("is pending, with the exact record to create, when the name does not resolve", () => {
    const c = evaluateDns(HOST, EXPECTED, NONE, OFF);
    expect(c.state).toBe("pending");
    expect(c.detail).toContain("does not resolve yet");
    expect(c.next).toBe("Create A app.example.com -> 203.0.113.7 at your DNS provider.");
    expect(evaluateDns(HOST, EXPECTED, NONE, cf()).next).toBe(c.next);
  });

  it("is pending, not failed, when the resolver itself did not answer", () => {
    const c = evaluateDns(HOST, EXPECTED, { ok: false, reason: "error", message: "the resolver did not answer within 5 seconds" }, OFF);
    expect(c.state).toBe("pending");
    expect(c.detail).toContain("did not answer");
  });

  it("is failed, and names both addresses, when the name resolves somewhere else", () => {
    const c = evaluateDns(HOST, EXPECTED, answers("198.51.100.9"), OFF);
    expect(c.state).toBe("failed");
    expect(c.detail).toBe("app.example.com resolves to 198.51.100.9, not the server's 203.0.113.7.");
    expect(c.next).toContain("A app.example.com -> 203.0.113.7");
  });

  it("is OK, with a caveat, when the name resolves into Cloudflare's network and no token can read the record", () => {
    const c = evaluateDns(HOST, EXPECTED, answers("104.21.55.9", "172.67.12.3"), OFF);
    expect(c.state).toBe("ok");
    expect(c.detail).toMatch(/Cloudflare's network \(proxied\)/);
    expect(c.next).toMatch(/Connect Cloudflare/);
  });

  describe("with the record read from Cloudflare", () => {
    it("compares a proxied record's content, not the resolved address (which is Cloudflare's)", () => {
      const c = evaluateDns(HOST, EXPECTED, answers("104.21.55.9"), cf(cfRecord({ proxied: true })));
      expect(c.state).toBe("ok");
      expect(c.detail).toContain("proxied");
      expect(c.detail).toContain("203.0.113.7");
    });

    it("is failed for a proxied record that points at another server, whatever the resolver says", () => {
      const c = evaluateDns(HOST, EXPECTED, answers("104.21.55.9"), cf(cfRecord({ proxied: true, content: "198.51.100.9" })));
      expect(c.state).toBe("failed");
      expect(c.detail).toBe("Cloudflare has A 198.51.100.9 for app.example.com, not the server's 203.0.113.7.");
      expect(c.next).toMatch(/confirm the replacement/);
    });

    it("is pending while a new proxied record does not resolve yet", () => {
      expect(evaluateDns(HOST, EXPECTED, NONE, cf(cfRecord({ proxied: true }))).state).toBe("pending");
    });

    it("is pending, with the cached answer, while a DNS-only record is right at Cloudflare but resolvers still say otherwise", () => {
      const c = evaluateDns(HOST, EXPECTED, answers("198.51.100.9"), cf(cfRecord()));
      expect(c.state).toBe("pending");
      expect(c.detail).toContain("198.51.100.9");
      expect(c.next).toMatch(/TTL/);
    });

    it("is pending while a new DNS-only record is not visible yet, and OK once it resolves", () => {
      expect(evaluateDns(HOST, EXPECTED, NONE, cf(cfRecord())).state).toBe("pending");
      expect(evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), cf(cfRecord())).state).toBe("ok");
    });

    it("is failed for a wrong DNS-only record and for a CNAME that does not lead to the server", () => {
      expect(evaluateDns(HOST, EXPECTED, answers("198.51.100.9"), cf(cfRecord({ content: "198.51.100.9" }))).state).toBe("failed");
      const c = evaluateDns(HOST, EXPECTED, answers("198.51.100.9"), cf(cfRecord({ type: "CNAME", content: "other.example.net" })));
      expect(c.state).toBe("failed");
      expect(c.detail).toContain("CNAME other.example.net");
    });

    it("is failed for a wrong address record even when the resolver answers with the server's address (a hosts file, split-horizon DNS or a cache)", () => {
      const c = evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), cf(cfRecord({ content: "198.51.100.9" })));
      expect(c.state).toBe("failed");
      expect(c.detail).toBe("Cloudflare has A 198.51.100.9 for app.example.com, not the server's 203.0.113.7.");
      expect(evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), cf(cfRecord({ content: "198.51.100.9", proxied: true }))).state).toBe("failed");
    });

    it("accepts a CNAME whose target resolves to the server", () => {
      expect(evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), cf(cfRecord({ type: "CNAME", content: "server.example.com" }))).state).toBe("ok");
    });

    it("falls back to what the resolver says when Cloudflare has no record of the name, or cannot be read", () => {
      expect(evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), cf()).state).toBe("ok");
      expect(evaluateDns(HOST, EXPECTED, NONE, { state: "error", message: "x" }).state).toBe("pending");
      expect(evaluateDns(HOST, EXPECTED, answers("203.0.113.7"), { state: "no_zone" }).state).toBe("ok");
    });

    it("works the same for an IPv6 server and an AAAA record", () => {
      const v6: ExpectedAddress = { type: "AAAA", ip: "2001:db8::7", source: "override" };
      const record = cfRecord({ type: "AAAA", content: "2001:0db8::7", proxied: true });
      expect(evaluateDns(HOST, v6, answers("2606:4700::1"), cf(record)).state).toBe("ok");
      expect(evaluateDns(HOST, v6, answers("2001:db8::7"), OFF).state).toBe("ok");
      // an A record elsewhere is not the AAAA we need
      expect(evaluateDns(HOST, v6, NONE, cf(cfRecord({ type: "A", content: "198.51.100.9" }))).state).toBe("failed");
    });
  });
});

describe("the proxy check", () => {
  it("is OK when the proxy routes the name to a running app", () => {
    expect(evaluateProxy(HOST, { state: "ok", view: view() })).toEqual({ state: "ok", detail: "Caddy routes app.example.com to app shop." });
  });

  it("is OK for a site, worded as a site", () => {
    const site = route({ kind: "site", app: "", site_kind: "static", running: false });
    expect(evaluateProxy(HOST, { state: "ok", view: view({ routes: [site] }) })).toEqual({ state: "ok", detail: "Caddy routes app.example.com to the static site." });
  });

  it("is pending, not failed, for an app that declares the name and has no route yet", () => {
    const c = evaluateProxy(HOST, { state: "ok", view: view({ routes: [], unrouted: [{ app: "shop", domains: [HOST], reason: "no deployment yet" }] }) });
    expect(c.state).toBe("pending");
    expect(c.detail).toContain("no deployment yet");
    expect(c.next).toMatch(/first deployment/);
  });

  it("is failed, and says where to declare it, for a name no app or site has", () => {
    const c = evaluateProxy("other.example.com", { state: "ok", view: view() });
    expect(c.state).toBe("failed");
    expect(c.detail).toContain("not declared");
    expect(c.next).toMatch(/domains/);
  });

  it("is failed for a route whose container is not running, and for a proxy that does not serve what the agent generates", () => {
    expect(evaluateProxy(HOST, { state: "ok", view: view({ routes: [route({ running: false })] }) }).detail).toMatch(/container is not running/);
    const out = evaluateProxy(HOST, { state: "ok", view: view({ in_sync: false, live_error: "connection reset" }) });
    expect(out.state).toBe("failed");
    expect(out.detail).toContain("connection reset");
    expect(evaluateProxy(HOST, { state: "ok", view: view({ in_sync: undefined, live_error: "dial tcp refused" }) }).state).toBe("failed");
  });

  it("is failed when the agent cannot be asked or has no proxy", () => {
    expect(evaluateProxy(HOST, { state: "error", message: "agent unreachable" })).toMatchObject({ state: "failed", detail: expect.stringContaining("agent unreachable") });
    expect(evaluateProxy(HOST, { state: "none" })).toMatchObject({ state: "failed", detail: expect.stringContaining("no reverse proxy") });
  });

  it("matches names whatever their case", () => {
    expect(evaluateProxy(HOST, { state: "ok", view: view({ routes: [route({ domains: ["APP.Example.com"] })] }) }).state).toBe("ok");
  });
});

describe("the HTTPS check", () => {
  it("is OK with a certificate a browser trusts, its issuer and days left, and the status of the GET", () => {
    const c = https();
    expect(c).toEqual({ state: "ok", detail: "Valid certificate from Let's Encrypt R11, 60 days left. GET https://app.example.com/ answered 200." });
  });

  it("is NEVER OK for Caddy's internal authority: it says the certificate is not publicly trusted, accurately", () => {
    const c = https({ cert: validCert({ issuer: "Caddy Local Authority - ECC Intermediate", trusted: false, trustError: "SELF_SIGNED_CERT_IN_CHAIN" }) });
    expect(c.state).toBe("failed");
    expect(c.detail).toBe("Certificate issued by Caddy Local Authority - ECC Intermediate, not publicly trusted (Caddy's internal authority, tls: internal): browsers will warn.");
    expect(c.next).toMatch(/Remove tls: internal/);
    expect(c.detail).not.toMatch(/Valid certificate/);
  });

  it("says another untrusted issuer is untrusted, with the verifier's reason", () => {
    const c = https({ cert: validCert({ issuer: "Acme Internal CA", trusted: false, trustError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    expect(c.state).toBe("failed");
    expect(c.detail).toContain("not publicly trusted (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
    expect(c.next).toMatch(/certificate chain/);
  });

  it("reminds that Cloudflare's SSL mode decides what visitors see, only when the record is proxied", () => {
    const untrusted = validCert({ trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(https({ cert: untrusted, proxied: true }).detail).toMatch(/Full \(strict\)/);
    expect(https({ cert: untrusted, proxied: false }).detail).not.toMatch(/Full \(strict\)/);
  });

  it("is failed for an expired certificate, with how long ago, and for one not valid yet", () => {
    const expired = https({ cert: validCert({ validTo: NOW - 3 * DAY - 1000 }) });
    expect(expired.state).toBe("failed");
    expect(expired.detail).toContain("expired 3 days ago");
    expect(expired.next).toMatch(/ACME/);
    expect(https({ cert: validCert({ validFrom: NOW + DAY }) }).detail).toMatch(/not valid yet/);
  });

  it("warns, still working, when the certificate has 14 days or fewer left, and says what to check", () => {
    const c = https({ cert: validCert({ validTo: NOW + 14 * DAY }) });
    expect(c).toMatchObject({ state: "ok", warn: true });
    expect(c.detail).toContain("only 14 days left");
    expect(c.next).toMatch(/ports 80 and 443/);
    expect(c.next).toMatch(/DNS points at this server/);
    expect(https({ cert: validCert({ validTo: NOW + 4 * DAY }) })).toMatchObject({ state: "ok", warn: true });
    expect(https({ cert: validCert({ validTo: NOW + 14 * DAY + 1000 }) }).warn).toBeUndefined();
  });

  it("fails when the certificate has 3 days or fewer left, or has expired, with the renewal advice", () => {
    for (const left of [3 * DAY, DAY, 5 * 3_600_000]) {
      const c = https({ cert: validCert({ validTo: NOW + left }) });
      expect(c.state).toBe("failed");
      expect(c.detail).toContain("left and was not renewed");
      expect(c.next).toMatch(/ports 80 and 443/);
    }
    expect(https({ cert: validCert({ validTo: NOW - 1000 }) }).next).toMatch(/DNS points at this server/);
  });

  it("says how long a certificate has left in the unit that means something: Caddy's own last twelve hours", () => {
    expect(https({ cert: validCert({ validTo: NOW + 11 * 3_600_000 + 5000 }) }).detail).toContain("11 hours left");
    expect(https({ cert: validCert({ validTo: NOW + 30 * 60_000 + 5000 }) }).detail).toContain("30 minutes left");
    expect(https({ cert: validCert({ validTo: NOW + 90 * 1000 }) }).detail).toContain("1 minute left");
    expect(https({ cert: validCert({ validTo: NOW + 2 * DAY + 1000 }) }).detail).toContain("2 days left");
    expect([span(36 * 3_600_000), span(3 * DAY), span(59 * 60_000), span(1000)]).toEqual(["36 hours", "3 days", "59 minutes", "1 minute"]);
  });

  it("is failed, naming the names, for a certificate that is for another host", () => {
    const c = https({ cert: validCert({ matches: false, trusted: false, names: ["other.example.com", "*.test.org"] }) });
    expect(c.state).toBe("failed");
    expect(c.detail).toContain("other.example.com, *.test.org");
    expect(c.detail).toContain("not app.example.com");
  });

  it("is pending while the proxy has no certificate for the name yet, and says what Caddy is waiting for", () => {
    const c = https({ cert: { kind: "no_cert", message: "tlsv1 alert internal error" } });
    expect(c.state).toBe("pending");
    expect(c.next).toMatch(/ACME/);
    expect(c.next).toMatch(/port 80/);
  });

  it("is failed when nothing listens on 443 or the port does not answer, each with its own next step", () => {
    const refused = https({ cert: { kind: "refused" } });
    expect(refused.state).toBe("failed");
    expect(refused.detail).toBe("Nothing accepts connections on port 443 of 203.0.113.7.");
    expect(refused.next).toMatch(/Start the proxy/);
    const slow = https({ cert: { kind: "timeout" } });
    expect(slow.detail).toContain("203.0.113.7:443 did not answer within 5 seconds");
    expect(slow.next).toMatch(/firewall/);
    expect(https({ cert: { kind: "unreachable", message: "EHOSTUNREACH" } }).detail).toContain("EHOSTUNREACH");
  });

  it("is failed when the app behind the proxy answers 5xx, even with a valid certificate", () => {
    const c = https({ get: { kind: "status", status: 502 } });
    expect(c.state).toBe("failed");
    expect(c.detail).toContain("answered 502");
    expect(c.next).toMatch(/app's container/);
  });

  it("is OK for a 404 or a redirect: the server answers, the app's content is not our business", () => {
    expect(https({ get: { kind: "status", status: 404 } }).state).toBe("ok");
    const redirect = https({ get: { kind: "status", status: 301, location: "https://www.example.com/" } });
    expect(redirect.state).toBe("ok");
    expect(redirect.detail).toContain("redirect to https://www.example.com/");
  });

  it("is pending when the certificate is fine at the server but the name does not answer yet because DNS is not done, failed when DNS is done", () => {
    const get = { kind: "error", message: "the name does not resolve from this dashboard" } as const;
    const waiting = https({ get, dnsOk: false });
    expect(waiting.state).toBe("pending");
    expect(waiting.next).toMatch(/DNS/);
    const broken = https({ get, dnsOk: true });
    expect(broken.state).toBe("failed");
    expect(broken.detail).toContain("could not be fetched");
  });

  it("is skipped when the host is not declared, when the address is unknown, and when nothing was probed", () => {
    expect(https({ declared: false }).state).toBe("skipped");
    expect(https({ expected: null }).state).toBe("skipped");
    expect(https({ cert: null }).state).toBe("skipped");
  });
});

describe("the three checks together", () => {
  const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
    hostname: HOST,
    now: NOW,
    expected: EXPECTED,
    declared: true,
    resolved: answers("203.0.113.7"),
    cloudflare: OFF,
    proxy: { state: "ok", view: view() },
    cert: validCert(),
    get: { kind: "status", status: 200 },
    ...over,
  });

  it("is OK all through for a domain that works", () => {
    const s = assembleStatus(facts());
    expect([s.dns.state, s.proxy.state, s.https.state]).toEqual(["ok", "ok", "ok"]);
    expect(overall(s)).toBe("ok");
    expect(s).toMatchObject({ hostname: HOST, checkedAt: NOW, expected: EXPECTED, cloudflare: "off" });
  });

  it("goes from pending to OK as DNS, then the certificate, arrive (a new domain's first minutes)", () => {
    const start = assembleStatus(facts({ resolved: NONE, cert: { kind: "no_cert", message: "alert" }, get: { kind: "error", message: "the name does not resolve from this dashboard" }, proxy: { state: "ok", view: view({ routes: [], unrouted: [{ app: "shop", domains: [HOST], reason: "no deployment yet" }] }) } }));
    expect([start.dns.state, start.proxy.state, start.https.state]).toEqual(["pending", "pending", "pending"]);
    expect(overall(start)).toBe("pending");

    const dnsDone = assembleStatus(facts({ cert: { kind: "no_cert", message: "alert" }, get: { kind: "error", message: "x" } }));
    expect([dnsDone.dns.state, dnsDone.proxy.state, dnsDone.https.state]).toEqual(["ok", "ok", "pending"]);

    const certNotYet = assembleStatus(facts({ resolved: NONE, get: { kind: "error", message: "the name does not resolve from this dashboard" } }));
    // the server already answers for the name by address while DNS is still on its way
    expect([certNotYet.dns.state, certNotYet.https.state]).toEqual(["pending", "pending"]);

    expect(overall(assembleStatus(facts()))).toBe("ok");
  });

  it("is failed overall as soon as one check failed, even while another is pending", () => {
    const s = assembleStatus(facts({ resolved: answers("198.51.100.9"), cert: { kind: "no_cert", message: "alert" }, get: { kind: "error", message: "x" } }));
    expect(s.dns.state).toBe("failed");
    expect(s.https.state).toBe("pending");
    expect(overall(s)).toBe("failed");
  });

  it("reports Caddy's internal certificate as failed overall, never as OK", () => {
    const s = assembleStatus(facts({ cert: validCert({ issuer: "Caddy Local Authority - ECC Intermediate", trusted: false, trustError: "SELF_SIGNED_CERT_IN_CHAIN" }), get: { kind: "error", message: "the certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN)" } }));
    expect(s.https.state).toBe("failed");
    expect(s.https.detail).toContain("Caddy Local Authority");
    expect(overall(s)).toBe("failed");
  });

  it("treats the record of a proxied host as proxied for the HTTPS wording", () => {
    const s = assembleStatus(facts({ cloudflare: cf(cfRecord({ proxied: true })), resolved: answers("104.21.55.9"), cert: validCert({ trusted: false, trustError: "SELF_SIGNED_CERT_IN_CHAIN" }) }));
    expect(s.cloudflare).toBe("connected");
    expect(s.dns.state).toBe("ok");
    expect(s.https.detail).toMatch(/Full \(strict\)/);
  });

  it("probes nothing for a host the agent does not declare, whatever else is known", () => {
    const s = assembleStatus(facts({ declared: false, proxy: { state: "ok", view: view({ routes: [] }) }, cert: validCert() }));
    expect(s.dns.state).toBe("skipped");
    expect(s.https.state).toBe("skipped");
    expect(s.proxy.state).toBe("failed");
    expect(overall(s)).toBe("failed");
  });

  it("carries why Cloudflare could not be read", () => {
    const s = assembleStatus(facts({ cloudflare: { state: "error", message: "Cloudflare's request limit was reached." } }));
    expect(s).toMatchObject({ cloudflare: "error", cloudflareError: "Cloudflare's request limit was reached." });
  });

  it("is skipped overall when nothing could be checked", () => {
    const s = assembleStatus(facts({ expected: null, cert: null, get: null, proxy: { state: "ok", view: view() } }));
    expect(s.dns.state).toBe("skipped");
    expect(s.https.state).toBe("skipped");
    expect(overall(s)).toBe("ok"); // the proxy check is the one that passed
  });

  it("describes the address that is expected", () => {
    expect(expectedOf(null)).toBeNull();
    expect(expectedOf({ ip: "2001:db8::7", family: 6, source: "override", private: null })).toEqual({ type: "AAAA", ip: "2001:db8::7", source: "override" });
  });
});

describe("the guard on what may be probed", () => {
  const declared = declaredHostnames(view({ routes: [route(), route({ kind: "site", app: "", domains: ["www.example.com", "Example.com"] })], unrouted: [{ app: "blog", domains: ["blog.example.com"], reason: "r" }] }));

  it("knows the hosts of the routes, the sites and the apps still waiting for a route, and nothing else", () => {
    expect([...declared].sort()).toEqual(["app.example.com", "blog.example.com", "example.com", "www.example.com"]);
    expect(declaredHostnames(null).size).toBe(0);
  });

  it("targets the server's own address, for a declared host name only", () => {
    expect(probeTarget(HOST, declared, EXPECTED)).toEqual({ ok: true, hostname: HOST, ip: "203.0.113.7" });
    expect(probeTarget("APP.example.com.", declared, EXPECTED)).toMatchObject({ ok: true, hostname: HOST });
  });

  it("refuses an IP literal, in any spelling", () => {
    for (const ip of ["203.0.113.7", "127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "[::1]", "2001:db8::1", "0x7f000001", "2130706433"]) {
      const out = probeTarget(ip, new Set([ip]), EXPECTED);
      expect(out.ok, ip).toBe(false);
    }
  });

  it("refuses a name the agent does not declare, a sibling and a look-alike", () => {
    for (const host of ["internal.example.com", "evil.com", "app.example.com.evil.net", "sub.app.example.com", "localhost", "metadata.google.internal"]) {
      const out = probeTarget(host, declared, EXPECTED);
      expect(out.ok, host).toBe(false);
    }
    expect(probeTarget("evil.com", declared, EXPECTED)).toMatchObject({ ok: false, reason: expect.stringContaining("not declared") });
  });

  it("refuses when the server's address is not known", () => {
    expect(probeTarget(HOST, declared, null)).toMatchObject({ ok: false, reason: expect.stringContaining("not known") });
  });

  it("lists the hosts of a proxy view, once each, for one app or all", () => {
    const v = view({ routes: [route(), route({ app: "api", domains: ["api.example.com", HOST] })], unrouted: [{ app: "shop", domains: ["next.example.com"], reason: "r" }] });
    expect(hostsOf(v).map((h) => h.hostname)).toEqual([HOST, "api.example.com", "next.example.com"]);
    expect(hostsOf(v, "shop")).toEqual([{ hostname: HOST, label: "shop" }, { hostname: "next.example.com", label: "shop" }]);
    expect(hostsOf(v, "nobody")).toEqual([]);
    expect(hostsOf(null)).toEqual([]);
  });
});

describe("how long a page keeps checking", () => {
  const status = (state: "ok" | "pending" | "failed"): DomainStatus => ({
    hostname: HOST,
    checkedAt: NOW,
    expected: EXPECTED,
    cloudflare: "off",
    dns: { state: "ok", detail: "" },
    proxy: { state: state === "pending" ? "pending" : "ok", detail: "" },
    https: { state: state === "failed" ? "failed" : "ok", detail: "" },
  });

  it("checks every few seconds at first, then less often, while something is pending", () => {
    expect(pollDelay(0, status("pending"))).toBe(5_000);
    expect(pollDelay(59_000, status("pending"))).toBe(5_000);
    expect(pollDelay(60_000, status("pending"))).toBe(10_000);
    expect(pollDelay(5 * 60_000, status("pending"))).toBe(20_000);
  });

  it("stops after ten minutes", () => {
    expect(pollDelay(POLL_LIMIT_MS - 1, status("pending"))).toBe(20_000);
    expect(pollDelay(POLL_LIMIT_MS, status("pending"))).toBeNull();
  });

  it("stops when nothing is pending: all OK, or failed (only the operator's Re-check looks again), or no answer yet", () => {
    expect(pollDelay(1000, status("ok"))).toBeNull();
    expect(pollDelay(1000, status("failed"))).toBeNull();
    expect(pollDelay(0, null)).toBeNull();
  });
});
