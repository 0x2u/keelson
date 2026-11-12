import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cloudflare from "@/lib/cloudflare";
import { CloudflareError } from "@/lib/cloudflare-core";
import { describeDns, ensureDnsRecord, manualMessage, planWizard, type DnsApi, type DnsDeps, type DnsRequest, type DnsSetup } from "@/lib/dns-record-core";
import { FakeCloudflare } from "./fake-cloudflare";

let cf: FakeCloudflare;
let audits: [string, string][];
let deps: DnsDeps;

beforeEach(() => {
  cf = new FakeCloudflare();
  vi.stubGlobal("fetch", cf.fetch);
  cf.addZone("example.com");
  cf.addZone("example.co.uk");
  audits = [];
  const token = cf.token;
  const api: DnsApi = {
    listRecords: (zone, name) => cloudflare.listRecords(token, zone, name),
    createRecord: (zone, record) => cloudflare.createRecord(token, zone, record),
    updateRecord: (zone, id, record) => cloudflare.updateRecord(token, zone, id, record),
    deleteRecord: (zone, id) => cloudflare.deleteRecord(token, zone, id),
  };
  deps = { zones: async () => (await cloudflare.listZones(token)).zones, api, audit: (event, detail) => void audits.push([event, detail]) };
});

const PUBLIC = { ip: "203.0.113.7", family: 4 as const, private: null };
const request = (over: Partial<DnsRequest> = {}): DnsRequest => ({ hostname: "app.example.com", address: PUBLIC, proxied: true, ...over });

describe("ensureDnsRecord: creating", () => {
  it("creates an A record, proxied by default, with an automatic TTL, and audits it", async () => {
    const out = await ensureDnsRecord(request(), deps);
    expect(out).toEqual({ kind: "created", zone: "example.com", record: { type: "A", content: "203.0.113.7", proxied: true } });
    expect(cf.writes).toHaveLength(1);
    expect(cf.writes[0]).toMatchObject({ method: "POST", body: { type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true, ttl: 1 } });
    expect(audits).toEqual([["dns_record_created", "app.example.com (zone example.com): A app.example.com -> 203.0.113.7, proxied"]]);
  });

  it("creates it DNS only when asked", async () => {
    const out = await ensureDnsRecord(request({ proxied: false }), deps);
    expect(out).toMatchObject({ kind: "created", record: { proxied: false } });
    expect(cf.recordsNamed("app.example.com")[0]).toMatchObject({ proxied: false });
    expect(audits[0]![1]).toContain("DNS only");
  });

  it("creates an AAAA record for an IPv6 server", async () => {
    const out = await ensureDnsRecord(request({ address: { ip: "2001:db8::7", family: 6, private: null } }), deps);
    expect(out).toMatchObject({ kind: "created", record: { type: "AAAA", content: "2001:db8::7" } });
  });

  it("picks the zone of a registered domain under a multi-level suffix, not a sibling", async () => {
    const out = await ensureDnsRecord(request({ hostname: "shop.example.co.uk" }), deps);
    expect(out).toMatchObject({ kind: "created", zone: "example.co.uk" });
    expect(cf.records.map((r) => r.zone_id)).toEqual(["zone-2"]);
  });

  it("lower-cases the host name", async () => {
    await ensureDnsRecord(request({ hostname: "App.Example.COM" }), deps);
    expect(cf.records[0]!.name).toBe("app.example.com");
  });
});

describe("ensureDnsRecord: idempotence", () => {
  it("does nothing, and says so, when the record is already right: the second call writes nothing", async () => {
    await ensureDnsRecord(request(), deps);
    const writes = cf.writes.length;
    const again = await ensureDnsRecord(request(), deps);
    expect(again).toEqual({ kind: "exists", zone: "example.com", record: { type: "A", content: "203.0.113.7", proxied: true } });
    expect(cf.writes).toHaveLength(writes);
    expect(audits).toHaveLength(1);
  });

  it("leaves an existing right record alone even when it is DNS only and proxied was asked", async () => {
    cf.addRecord("example.com", { type: "A", name: "app.example.com", content: "203.0.113.7", proxied: false });
    const out = await ensureDnsRecord(request({ proxied: true }), deps);
    expect(out).toMatchObject({ kind: "exists", record: { proxied: false } });
    expect(cf.writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("recognises an IPv6 address written differently", async () => {
    cf.addRecord("example.com", { type: "AAAA", name: "app.example.com", content: "2001:0db8:0000:0000:0000:0000:0000:0007" });
    expect(await ensureDnsRecord(request({ address: { ip: "2001:db8::7", family: 6, private: null } }), deps)).toMatchObject({ kind: "exists" });
  });

  it("does not touch an AAAA when it creates the A", async () => {
    cf.addRecord("example.com", { type: "AAAA", name: "app.example.com", content: "2001:db8::9" });
    const out = await ensureDnsRecord(request(), deps);
    expect(out.kind).toBe("created");
    expect(cf.recordsNamed("app.example.com").map((r) => r.type).sort()).toEqual(["A", "AAAA"]);
  });
});

describe("ensureDnsRecord: a record that is not ours", () => {
  beforeEach(() => {
    cf.addRecord("example.com", { type: "A", name: "app.example.com", content: "198.51.100.9", proxied: false });
  });

  it("is reported with the old value and changed in no way", async () => {
    const out = await ensureDnsRecord(request(), deps);
    expect(out).toEqual({ kind: "conflict", zone: "example.com", existing: [{ type: "A", content: "198.51.100.9", proxied: false }], confirm: "A 198.51.100.9" });
    expect(cf.writes).toEqual([]);
    expect(cf.recordsNamed("app.example.com")[0]!.content).toBe("198.51.100.9");
    expect(audits).toEqual([]);
    expect(describeDns(out, "app.example.com")).toContain("A 198.51.100.9");
  });

  it("is not overwritten by a confirmation that names something else, or that is out of date", async () => {
    for (const confirmReplace of ["yes", "true", "A 203.0.113.7", "A 198.51.100.8", "", "a 198.51.100.9"]) {
      const out = await ensureDnsRecord(request({ confirmReplace }), deps);
      expect(out.kind, confirmReplace).toBe("conflict");
    }
    expect(cf.writes).toEqual([]);
  });

  it("is replaced in place once the old value is confirmed by name, and audited with the old and the new value", async () => {
    const before = cf.recordsNamed("app.example.com")[0]!.id;
    const out = await ensureDnsRecord(request({ confirmReplace: "A 198.51.100.9" }), deps);
    expect(out).toEqual({ kind: "replaced", zone: "example.com", old: "A 198.51.100.9", record: { type: "A", content: "203.0.113.7", proxied: true } });
    expect(cf.recordsNamed("app.example.com")).toMatchObject([{ id: before, content: "203.0.113.7", proxied: true }]);
    expect(cf.writes.map((w) => w.method)).toEqual(["PUT"]);
    expect(audits).toEqual([["dns_record_replaced", "app.example.com (zone example.com): was A 198.51.100.9, now A app.example.com -> 203.0.113.7, proxied"]]);
  });

  it("replaces a CNAME by deleting it and creating the address record (a name cannot hold both)", async () => {
    cf.records = [];
    cf.addRecord("example.com", { type: "CNAME", name: "app.example.com", content: "old.example.net" });
    const asked = await ensureDnsRecord(request(), deps);
    expect(asked).toMatchObject({ kind: "conflict", confirm: "CNAME old.example.net" });
    const done = await ensureDnsRecord(request({ confirmReplace: "CNAME old.example.net" }), deps);
    expect(done).toMatchObject({ kind: "replaced", old: "CNAME old.example.net" });
    expect(cf.writes.map((w) => w.method)).toEqual(["DELETE", "POST"]);
    expect(cf.recordsNamed("app.example.com").map((r) => `${r.type} ${r.content}`)).toEqual(["A 203.0.113.7"]);
  });

  it("names every conflicting value, and one confirmation covers exactly that set", async () => {
    cf.addRecord("example.com", { type: "A", name: "app.example.com", content: "198.51.100.10" });
    const asked = await ensureDnsRecord(request(), deps);
    expect(asked).toMatchObject({ kind: "conflict", confirm: "A 198.51.100.10, A 198.51.100.9" });
    // a confirmation of only one of the two is not the confirmation of the set
    expect((await ensureDnsRecord(request({ confirmReplace: "A 198.51.100.9" }), deps)).kind).toBe("conflict");
    const done = await ensureDnsRecord(request({ confirmReplace: "A 198.51.100.10, A 198.51.100.9" }), deps);
    expect(done.kind).toBe("replaced");
    expect(cf.recordsNamed("app.example.com").map((r) => r.content)).toEqual(["203.0.113.7"]);
  });

  it("is reported again when the record changed between the question and the confirmation", async () => {
    const asked = await ensureDnsRecord(request(), deps);
    if (asked.kind !== "conflict") throw new Error("expected a conflict");
    cf.recordsNamed("app.example.com")[0]!.content = "198.51.100.77";
    const out = await ensureDnsRecord(request({ confirmReplace: asked.confirm }), deps);
    expect(out).toMatchObject({ kind: "conflict", confirm: "A 198.51.100.77" });
    expect(cf.writes).toEqual([]);
  });
});

describe("ensureDnsRecord: addresses and zones", () => {
  it("refuses a private, loopback or link-local address before asking Cloudflare anything", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.1.1", "192.168.0.2", "100.64.1.1"]) {
      const out = await ensureDnsRecord(request({ address: { ip, family: 4, private: "a private network address" } }), deps);
      expect(out.kind, ip).toBe("private");
      expect(out).toMatchObject({ ip, message: expect.stringContaining("split-horizon") });
    }
    expect(cf.calls).toEqual([]);
  });

  it("creates the record for a private address only when the operator confirmed, and the audit says so", async () => {
    const out = await ensureDnsRecord(request({ address: { ip: "10.0.0.5", family: 4, private: "a private network address" }, allowPrivate: true }), deps);
    expect(out.kind).toBe("created");
    expect(audits[0]![1]).toContain("[private address confirmed]");
  });

  it("says when no zone covers the host, and writes nothing", async () => {
    const out = await ensureDnsRecord(request({ hostname: "app.unknown.org" }), deps);
    expect(out).toMatchObject({ kind: "no_zone", message: expect.stringContaining("app.unknown.org") });
    expect(cf.writes).toEqual([]);
  });

  it("does not match a look-alike zone", async () => {
    expect((await ensureDnsRecord(request({ hostname: "app.notexample.com" }), deps)).kind).toBe("no_zone");
  });

  it("refuses text that is not a host name", async () => {
    for (const hostname of ["203.0.113.7", "", "localhost", "a b.example.com", "https://app.example.com"]) {
      expect((await ensureDnsRecord(request({ hostname }), deps)).kind, hostname).toBe("failed");
    }
    expect(cf.calls).toEqual([]);
  });
});

describe("ensureDnsRecord: when Cloudflare says no", () => {
  it("reports a missing DNS permission as a failure that names it, without changing anything", async () => {
    cf.can.dnsEdit = false;
    const out = await ensureDnsRecord(request(), deps);
    expect(out).toMatchObject({ kind: "failed", message: expect.stringContaining("Zone → DNS → Edit") });
    expect(cf.records).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("reports a rate limit and a Cloudflare outage as failures, not exceptions", async () => {
    cf.rateLimit = 10;
    expect(await ensureDnsRecord(request(), deps)).toMatchObject({ kind: "failed", message: expect.stringContaining("10 seconds") });
    cf.rateLimit = null;
    cf.broken = 503;
    expect(await ensureDnsRecord(request(), deps)).toMatchObject({ kind: "failed", message: expect.stringContaining("503") });
  });

  it("turns a surprise into a generic failure that carries nothing from the error", async () => {
    const out = await ensureDnsRecord(request(), { ...deps, zones: async () => { throw new Error(`boom ${cf.token}`); } });
    expect(out).toEqual({ kind: "failed", message: "Something went wrong talking to Cloudflare." });
    const known = await ensureDnsRecord(request(), { ...deps, zones: async () => { throw new CloudflareError("Cloudflare says no.", "forbidden", 403); } });
    expect(known).toEqual({ kind: "failed", message: "Cloudflare says no." });
  });
});

describe("the token never reaches the audit or the result", () => {
  it("is in no audit entry and no result of any outcome", async () => {
    const results = [
      await ensureDnsRecord(request(), deps),
      await ensureDnsRecord(request(), deps),
      await ensureDnsRecord(request({ hostname: "app.nowhere.org" }), deps),
    ];
    cf.addRecord("example.com", { type: "A", name: "b.example.com", content: "198.51.100.1" });
    results.push(await ensureDnsRecord(request({ hostname: "b.example.com" }), deps));
    results.push(await ensureDnsRecord(request({ hostname: "b.example.com", confirmReplace: "A 198.51.100.1" }), deps));
    const text = JSON.stringify([results, audits]);
    expect(text).not.toContain(cf.token);
    expect(text).not.toMatch(/Bearer/);
  });
});

describe("the plan shown before anything is created", () => {
  const setup = (over: Partial<DnsSetup> = {}): DnsSetup => ({
    connected: true,
    zones: ["example.com", "example.co.uk"],
    zonesError: null,
    address: { ok: true, ip: "203.0.113.7", type: "A", source: "the host of the agent's URL", private: null },
    ...over,
  });

  it("is a creation at Cloudflare when connected and the zone is there", () => {
    expect(planWizard("shop.example.com", setup())).toEqual({ kind: "cloudflare", zone: "example.com", type: "A", ip: "203.0.113.7", privateReason: null });
    expect(planWizard("shop.example.co.uk", setup())).toMatchObject({ kind: "cloudflare", zone: "example.co.uk" });
  });

  it("carries the reason an address is private", () => {
    const plan = planWizard("shop.example.com", setup({ address: { ok: true, ip: "127.0.0.1", type: "A", source: "x", private: "a loopback address" } }));
    expect(plan).toMatchObject({ kind: "cloudflare", privateReason: "a loopback address" });
  });

  it("is the exact record to create by hand when Cloudflare is not connected", () => {
    const plan = planWizard("Shop.Example.com", setup({ connected: false, zones: [] }));
    expect(plan).toEqual({ kind: "manual", why: "not_connected", message: expect.stringContaining("not connected"), record: { type: "A", name: "shop.example.com", content: "203.0.113.7" } });
  });

  it("is the exact record to create by hand when the zone is elsewhere, or could not be listed", () => {
    expect(planWizard("shop.other.org", setup())).toMatchObject({ kind: "manual", why: "no_zone", record: { name: "shop.other.org" } });
    expect(planWizard("shop.example.com", setup({ zones: [], zonesError: "Cloudflare no longer accepts the stored token" }))).toMatchObject({ kind: "manual", why: "zones_error", message: "Cloudflare no longer accepts the stored token" });
  });

  it("is an AAAA for an IPv6 server, and no record when the address is unknown", () => {
    expect(planWizard("shop.example.com", setup({ address: { ok: true, ip: "2001:db8::7", type: "AAAA", source: "x", private: null } }))).toMatchObject({ kind: "cloudflare", type: "AAAA" });
    expect(planWizard("shop.example.com", setup({ address: { ok: false, error: "did not resolve" } }))).toEqual({ kind: "manual", why: "no_address", message: "did not resolve", record: null });
  });

  it("words the manual step with the exact values, or why they cannot be given", () => {
    expect(manualMessage("shop.example.com", { ip: "203.0.113.7", family: 4 })).toBe("Not created by Keelson. Create A shop.example.com -> 203.0.113.7 at your DNS provider yourself.");
    expect(manualMessage("shop.example.com", { ip: "2001:db8::7", family: 6 })).toContain("AAAA shop.example.com -> 2001:db8::7");
    expect(manualMessage("shop.example.com", null)).toMatch(/public address is not known/);
  });
});
