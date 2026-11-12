import { afterEach, describe, expect, it } from "vitest";
import { clientIpConfig, clientIpFrom, clientIpKnowable, normaliseIp, requestIp } from "@/lib/client-ip";

const h = (headers: Record<string, string>) => new Headers(headers);
const behind = (hops: number) => ({ trustProxy: true, hops, header: null });

describe("the client's address behind a reverse proxy", () => {
  it("is the entry the outermost trusted proxy recorded, counted from the right: the client's own words to the left are never used", () => {
    // The client sent "X-Forwarded-For: 10.0.0.1" to look allowed; Cloudflare appended the real address, nginx appended Cloudflare's.
    expect(clientIpFrom(h({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }), behind(1))).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-forwarded-for": "10.0.0.1, 203.0.113.7, 172.68.1.1" }), behind(2))).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.7" }), behind(1))).toBe("203.0.113.7");
  });

  it("is unknown, not the leftmost entry, when the chain is shorter than the proxies it should have crossed", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "10.0.0.1" }), behind(2))).toBe("unknown");
    expect(clientIpFrom(h({}), behind(1))).toBe("unknown");
    expect(clientIpFrom(h({ "x-forwarded-for": "not-an-address" }), behind(1))).toBe("unknown");
  });

  it("is 'local' when no proxy is trusted: every client looks the same and nothing the client says counts", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.7" }), { trustProxy: false, hops: 1, header: null })).toBe("local");
  });

  it("takes a named header (CF-Connecting-IP) over X-Forwarded-For, trusting it by being named", () => {
    const config = { trustProxy: false, hops: 1, header: "cf-connecting-ip" };
    expect(clientIpFrom(h({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "10.0.0.1" }), config)).toBe("198.51.100.4");
    expect(clientIpFrom(h({ "x-forwarded-for": "198.51.100.4" }), config)).toBe("unknown");
    expect(clientIpFrom(h({ "cf-connecting-ip": "evil; drop table" }), config)).toBe("unknown");
    expect(clientIpKnowable(config)).toBe(true);
    expect(clientIpKnowable({ trustProxy: false, hops: 1, header: null })).toBe(false);
  });

  it("reads an address a proxy wrote with a port or brackets, and an IPv4-mapped IPv6 one, as the address it is", () => {
    expect(normaliseIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normaliseIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normaliseIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normaliseIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normaliseIp("999.1.1.1")).toBeNull();
    expect(normaliseIp("")).toBeNull();
  });
});

describe("the configuration from the environment", () => {
  afterEach(() => {
    delete process.env.KEELSON_TRUST_PROXY;
    delete process.env.KEELSON_TRUSTED_HOPS;
    delete process.env.KEELSON_CLIENT_IP_HEADER;
  });

  it("counts one proxy by default and reads the number of hops and the header from the variables", () => {
    process.env.KEELSON_TRUST_PROXY = "true";
    expect(clientIpConfig()).toMatchObject({ trustProxy: true, hops: 1, header: null });
    process.env.KEELSON_TRUSTED_HOPS = "2";
    process.env.KEELSON_CLIENT_IP_HEADER = "CF-Connecting-IP";
    expect(clientIpConfig()).toMatchObject({ trustProxy: true, hops: 2, header: "cf-connecting-ip" });
    expect(requestIp(new Request("http://x/", { headers: { "cf-connecting-ip": "198.51.100.4" } }))).toBe("198.51.100.4");
  });

  it("refuses a number of hops that is not one", () => {
    process.env.KEELSON_TRUST_PROXY = "true";
    for (const bad of ["0", "-1", "x", "11", "1.5"]) {
      process.env.KEELSON_TRUSTED_HOPS = bad;
      expect(() => clientIpConfig(), bad).toThrow(/KEELSON_TRUSTED_HOPS/);
    }
  });

  it("is 'local' without KEELSON_TRUST_PROXY, whatever the request says", () => {
    expect(requestIp(new Request("http://x/", { headers: { "x-forwarded-for": "10.0.0.1" } }))).toBe("local");
  });
});
