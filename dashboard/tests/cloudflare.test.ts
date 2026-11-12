import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecord, deleteRecord, listRecords, listZones, updateRecord, verifyToken } from "@/lib/cloudflare";
import { CloudflareError } from "@/lib/cloudflare-core";
import { FakeCloudflare } from "./fake-cloudflare";

let cf: FakeCloudflare;
beforeEach(() => {
  cf = new FakeCloudflare();
  vi.stubGlobal("fetch", cf.fetch);
});

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CloudflareError) return err.code;
    throw err;
  }
  return "no error";
};

describe("the token", () => {
  it("is verified with Cloudflare's endpoint and sent only as a bearer header to api.cloudflare.com", async () => {
    const info = await verifyToken(cf.token);
    expect(info).toEqual({ id: "tok-0001", expiresOn: "2027-01-01T00:00:00Z" });
    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]).toMatchObject({ method: "GET", path: "/user/tokens/verify", auth: `Bearer ${cf.token}` });
  });

  it("is refused when Cloudflare does not know it, with a message that does not contain it", async () => {
    const err = await verifyToken("cf-wrong-token-9999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect((err as CloudflareError).code).toBe("invalid_token");
    expect((err as CloudflareError).message).not.toContain("cf-wrong-token-9999");
  });

  it("is refused when it is expired or disabled", async () => {
    cf.status = "expired";
    expect(await code(verifyToken(cf.token))).toBe("invalid_token");
  });

  it("is accepted without the verify endpoint when it can list zones (an account-owned token)", async () => {
    cf.userVerify = false;
    cf.addZone("example.com");
    expect(await verifyToken(cf.token)).toEqual({ id: null, expiresOn: null });
    cf.userVerify = false;
    cf.can.zonesRead = false;
    expect(await code(verifyToken(cf.token))).toBe("invalid_token");
  });

  it("is never followed by a redirect, and nothing is cached", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return cf.fetch(input, init);
    });
    await verifyToken(cf.token);
    expect(seen[0]).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers a Cloudflare redirect as an unreachable API rather than sending the token on", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed: redirect mode is set to error");
    });
    const err = await verifyToken(cf.token).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unreachable" });
    expect(String((err as Error).message)).not.toContain(cf.token);
  });
});

describe("zones", () => {
  it("are read page by page until the last", async () => {
    for (let i = 1; i <= 120; i++) cf.addZone(`site${i}.example.com`);
    const { zones, truncated } = await listZones(cf.token);
    expect(zones).toHaveLength(120);
    expect(truncated).toBe(false);
    expect(zones[0]).toEqual({ id: "zone-1", name: "site1.example.com" });
    expect(zones[119]!.name).toBe("site120.example.com");
    const pages = cf.calls.filter((c) => c.path === "/zones").map((c) => c.query.page);
    expect(pages).toEqual(["1", "2", "3"]);
    expect(cf.calls.every((c) => c.query.per_page === undefined || c.query.per_page === "50")).toBe(true);
  });

  it("are cut off, and say so, past a thousand", async () => {
    cf.maxPerPage = 50;
    for (let i = 1; i <= 1100; i++) cf.addZone(`s${i}.example.com`);
    const { zones, truncated } = await listZones(cf.token);
    expect(zones).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it("name the permission the token lacks", async () => {
    cf.can.zonesRead = false;
    const err = await listZones(cf.token).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "forbidden" });
    expect((err as Error).message).toContain("Zone → Zone → Read");
  });
});

describe("records", () => {
  it("are listed by exact name and type: A, AAAA and CNAME", async () => {
    const id = cf.addZone("example.com");
    cf.addRecord("example.com", { type: "A", name: "app.example.com", content: "203.0.113.7" });
    cf.addRecord("example.com", { type: "TXT", name: "app.example.com", content: "v=spf1" });
    cf.addRecord("example.com", { type: "A", name: "other.example.com", content: "203.0.113.9" });
    const found = await listRecords(cf.token, id, "app.example.com");
    expect(found.map((r) => `${r.type} ${r.content}`)).toEqual(["A 203.0.113.7"]);
    expect(cf.calls.map((c) => c.query.type)).toEqual(["A", "AAAA", "CNAME"]);
    expect(cf.calls.every((c) => c.query.name === "app.example.com")).toBe(true);
  });

  it("are created proxied or DNS only with an automatic TTL, updated in place, and deleted", async () => {
    const id = cf.addZone("example.com");
    const made = await createRecord(cf.token, id, { type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true });
    expect(made).toMatchObject({ type: "A", content: "203.0.113.7", proxied: true, ttl: 1 });
    expect(cf.writes[0]).toMatchObject({ method: "POST", body: { type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true, ttl: 1 } });

    const updated = await updateRecord(cf.token, id, made.id, { type: "A", name: "app.example.com", content: "203.0.113.8", proxied: false });
    expect(updated).toMatchObject({ id: made.id, content: "203.0.113.8", proxied: false });
    expect(cf.writes[1]).toMatchObject({ method: "PUT" });

    await deleteRecord(cf.token, id, made.id);
    expect(cf.records).toEqual([]);
    expect(cf.writes[2]).toMatchObject({ method: "DELETE" });
  });

  it("name the permission the token lacks, for reading and for writing", async () => {
    const id = cf.addZone("example.com");
    cf.can.dnsRead = false;
    expect(await code(listRecords(cf.token, id, "app.example.com"))).toBe("forbidden");
    cf.can = { zonesRead: true, dnsRead: true, dnsEdit: false };
    const err = await createRecord(cf.token, id, { type: "A", name: "a.example.com", content: "1.2.3.4", proxied: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "forbidden" });
    expect((err as Error).message).toContain("Zone → DNS → Edit");
    expect(cf.records).toEqual([]);
  });

  it("report an unknown zone and a record Cloudflare refuses, in plain words", async () => {
    expect(await code(listRecords(cf.token, "zone-404", "a.example.com"))).toBe("not_found");
    const id = cf.addZone("example.com");
    cf.addRecord("example.com", { type: "A", name: "a.example.com", content: "1.2.3.4" });
    const err = await createRecord(cf.token, id, { type: "A", name: "a.example.com", content: "1.2.3.4", proxied: true }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/identical record/);
  });
});

describe("whatever goes wrong", () => {
  it("is a rate limit with the wait, when Cloudflare says so", async () => {
    cf.rateLimit = 42;
    const err = await listZones(cf.token).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited" });
    expect((err as Error).message).toContain("42 seconds");
  });

  it("is an unreachable API when Cloudflare is down, whatever the body looks like", async () => {
    cf.broken = 502;
    const err = await listZones(cf.token).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unreachable", status: 502 });
    expect((err as Error).message).not.toContain("<html>");
  });

  it("is an unreachable API when the connection fails or times out, without the token in the message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await listZones(cf.token).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unreachable", status: 0 });
    expect((err as Error).message).toMatch(/Could not reach api.cloudflare.com/);
    expect(JSON.stringify(err)).not.toContain(cf.token);
  });

  it("is not tricked by an answer that is not Cloudflare's JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>captive portal</html>", { status: 200 }));
    expect(await code(listZones(cf.token))).toBe("unexpected");
  });
});
