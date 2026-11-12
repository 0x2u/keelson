import { describe, expect, it } from "vitest";
import { CloudflareError, conflictValue, explainFailure, parseRecords, parseVerify, parseZones, planRecord, recordLine, zoneFor, type CfRecord, type CfZone } from "@/lib/cloudflare-core";

const zone = (name: string): CfZone => ({ id: `id-${name}`, name });
const record = (type: string, content: string, over: Partial<CfRecord> = {}): CfRecord => ({ id: `r-${type}-${content}`, type, name: "app.example.com", content, proxied: false, ttl: 1, ...over });

describe("zoneFor", () => {
  it("picks the zone whose name the host ends with, at a label boundary", () => {
    expect(zoneFor("app.example.com", [zone("example.com")])?.name).toBe("example.com");
    expect(zoneFor("example.com", [zone("example.com")])?.name).toBe("example.com");
    expect(zoneFor("a.b.c.example.com", [zone("example.com")])?.name).toBe("example.com");
  });

  it("takes the longest matching suffix when a subdomain is a zone of its own", () => {
    const zones = [zone("example.com"), zone("eu.example.com"), zone("other.com")];
    expect(zoneFor("shop.eu.example.com", zones)?.name).toBe("eu.example.com");
    expect(zoneFor("shop.example.com", zones)?.name).toBe("example.com");
    expect(zoneFor("shop.eu.example.com", [...zones].reverse())?.name).toBe("eu.example.com");
  });

  it("handles registries with a multi-level public suffix: the zone is the registered domain", () => {
    expect(zoneFor("app.example.co.uk", [zone("example.co.uk"), zone("example.com")])?.name).toBe("example.co.uk");
    expect(zoneFor("example.co.uk", [zone("example.co.uk")])?.name).toBe("example.co.uk");
    expect(zoneFor("app.example.com.au", [zone("example.com.au")])?.name).toBe("example.com.au");
  });

  it("does not match a sibling or a look-alike", () => {
    expect(zoneFor("notexample.com", [zone("example.com")])).toBeNull();
    expect(zoneFor("example.com.evil.net", [zone("example.com")])).toBeNull();
    expect(zoneFor("app.example.co.uk", [zone("co.uk-example.com"), zone("other.co.uk")])).toBeNull();
    expect(zoneFor("example.org", [zone("example.com")])).toBeNull();
    expect(zoneFor("com", [zone("example.com")])).toBeNull();
    expect(zoneFor("app.example.com", [])).toBeNull();
  });

  it("ignores case and a trailing dot", () => {
    expect(zoneFor("App.Example.COM.", [zone("Example.com")])?.name).toBe("Example.com");
  });
});

describe("planRecord", () => {
  it("creates when the name has nothing that competes", () => {
    expect(planRecord("app.example.com", 4, "203.0.113.7", [])).toEqual({ action: "create" });
    expect(planRecord("app.example.com", 4, "203.0.113.7", [record("TXT", "hello")])).toEqual({ action: "create" });
    expect(planRecord("app.example.com", 4, "203.0.113.7", [record("A", "198.51.100.1", { name: "other.example.com" })])).toEqual({ action: "create" });
  });

  it("does nothing when a record of the right type already has the address, whatever its proxied flag", () => {
    const proxied = record("A", "203.0.113.7", { proxied: true });
    expect(planRecord("app.example.com", 4, "203.0.113.7", [proxied])).toEqual({ action: "none", record: proxied });
    const dnsOnly = record("A", "203.0.113.7");
    expect(planRecord("app.example.com", 4, "203.0.113.7", [dnsOnly])).toMatchObject({ action: "none" });
    // among several addresses, the right one is enough
    expect(planRecord("app.example.com", 4, "203.0.113.7", [record("A", "198.51.100.1"), dnsOnly])).toMatchObject({ action: "none" });
  });

  it("recognises the same IPv6 address in another spelling", () => {
    const v6 = record("AAAA", "2001:0db8:0:0:0:0:0:1");
    expect(planRecord("app.example.com", 6, "2001:db8::1", [v6])).toMatchObject({ action: "none" });
  });

  it("reports a conflict for another address of the same type, and for any CNAME", () => {
    const other = record("A", "198.51.100.1");
    expect(planRecord("app.example.com", 4, "203.0.113.7", [other])).toEqual({ action: "conflict", existing: [other] });
    const cname = record("CNAME", "elsewhere.example.net");
    expect(planRecord("app.example.com", 4, "203.0.113.7", [cname])).toEqual({ action: "conflict", existing: [cname] });
    expect(planRecord("app.example.com", 6, "2001:db8::1", [cname])).toMatchObject({ action: "conflict" });
  });

  it("does not call the other address family a conflict", () => {
    expect(planRecord("app.example.com", 4, "203.0.113.7", [record("AAAA", "2001:db8::9")])).toEqual({ action: "create" });
    expect(planRecord("app.example.com", 6, "2001:db8::1", [record("A", "198.51.100.1")])).toEqual({ action: "create" });
  });

  it("names the old value the same way every time, for the confirmation", () => {
    expect(conflictValue([record("A", "198.51.100.2"), record("A", "198.51.100.1")])).toBe("A 198.51.100.1, A 198.51.100.2");
    expect(conflictValue([record("CNAME", "x.example.net")])).toBe("CNAME x.example.net");
    expect(recordLine("A", "app.example.com", "203.0.113.7", true)).toBe("A app.example.com -> 203.0.113.7, proxied");
    expect(recordLine("AAAA", "app.example.com", "2001:db8::1", false)).toBe("AAAA app.example.com -> 2001:db8::1, DNS only");
  });
});

describe("explainFailure", () => {
  it("says an invalid token is invalid, for a rejected or malformed one", () => {
    for (const [status, code] of [[401, 1000], [400, 6003], [401, 9103], [403, 1000]] as const) {
      const err = explainFailure(status, [{ code, message: "Invalid API Token" }], "verify");
      expect(err).toBeInstanceOf(CloudflareError);
      expect(err.code, `${status}/${code}`).toBe("invalid_token");
      expect(err.message).toMatch(/did not accept this token/);
    }
  });

  it("says a missing permission is missing, per kind of call, and names the permission", () => {
    const zones = explainFailure(403, [{ code: 9109 }], "zones");
    expect(zones.code).toBe("forbidden");
    expect(zones.message).toContain("Zone → Zone → Read");
    const records = explainFailure(403, [{ code: 10000 }], "records");
    expect(records.code).toBe("forbidden");
    expect(records.message).toContain("Zone → DNS → Edit");
    const write = explainFailure(403, [{ code: 10000, message: "Authentication error" }], "write");
    expect(write.code).toBe("forbidden");
    expect(write.message).toMatch(/include this zone in its resources/);
  });

  it("says a token that stopped working after it was stored needs replacing", () => {
    const err = explainFailure(401, [{ code: 1000 }], "zones");
    expect(err.code).toBe("invalid_token");
    expect(err.message).toMatch(/Connect a new one/);
  });

  it("says when the rate limit was reached and for how long", () => {
    const err = explainFailure(429, [], "records", 30);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("30 seconds");
    expect(explainFailure(429, [], "records").message).toContain("a minute");
  });

  it("maps a missing object, a broken Cloudflare and anything else, without echoing a body", () => {
    expect(explainFailure(404, [], "write").code).toBe("not_found");
    const down = explainFailure(502, [], "zones");
    expect(down.code).toBe("unreachable");
    expect(down.message).toContain("502");
    const odd = explainFailure(400, [{ code: 81058, message: "An identical record already exists." }], "write");
    expect(odd.code).toBe("unexpected");
    expect(odd.message).toContain("identical record");
    expect(explainFailure(400, [{ message: "x".repeat(1000) }], "write").message.length).toBeLessThan(300);
  });
});

describe("what Cloudflare answers", () => {
  it("reads a verified token and refuses one that is not active", () => {
    expect(parseVerify({ id: "t1", status: "active", expires_on: "2027-01-01T00:00:00Z" })).toEqual({ id: "t1", expiresOn: "2027-01-01T00:00:00Z" });
    expect(() => parseVerify({ id: "t1", status: "expired" })).toThrow(/expired/);
    expect(() => parseVerify("nonsense")).toThrow(CloudflareError);
  });

  it("reads zones and records, lower-casing names and defaulting the optional parts", () => {
    expect(parseZones([{ id: "z1", name: "Example.COM", status: "active" }])).toEqual([{ id: "z1", name: "example.com" }]);
    expect(parseRecords([{ id: "r1", type: "a", name: "App.Example.com", content: "1.2.3.4" }])).toEqual([{ id: "r1", type: "A", name: "app.example.com", content: "1.2.3.4", proxied: false, ttl: 1 }]);
    expect(() => parseZones([{ nope: 1 }])).toThrow(CloudflareError);
    expect(() => parseRecords("x")).toThrow(CloudflareError);
  });
});
