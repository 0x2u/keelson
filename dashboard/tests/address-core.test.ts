import { describe, expect, it } from "vitest";
import { cleanHostname, deriveAddress, describeSource, isCloudflareAddress, isHostname, normalizePublicIp, parseIp, privateMessage, privateReason, recordType, sameIp } from "@/lib/address-core";

describe("parseIp", () => {
  it("keeps IPv4 as written and writes IPv6 in one canonical form", () => {
    expect(parseIp("203.0.113.7")).toEqual({ text: "203.0.113.7", family: 4 });
    expect(parseIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toEqual({ text: "2001:db8::1", family: 6 });
    expect(parseIp("2001:db8::1")?.text).toBe("2001:db8::1");
    expect(parseIp("::1")?.text).toBe("::1");
    expect(parseIp("::")?.text).toBe("::");
    expect(parseIp("::ffff:1.2.3.4")?.text).toBe("::ffff:102:304");
    expect(parseIp("2001:db8:0:0:1:0:0:1")?.text).toBe("2001:db8::1:0:0:1");
  });

  it("refuses what is not an address: names, ports, CIDRs, zone ids, leading zeros, out-of-range parts", () => {
    for (const bad of ["", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.04", "1.2.3.4:443", "1.2.3.0/24", "fe80::1%eth0", "[::1]", "2001:db8::1::2", "12345::1", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it("compares addresses whatever their spelling", () => {
    expect(sameIp("2001:DB8::0:1", "2001:db8::1")).toBe(true);
    expect(sameIp("1.2.3.4", "1.2.3.5")).toBe(false);
    expect(sameIp("1.2.3.4", "app.example.com")).toBe(false);
  });
});

describe("privateReason", () => {
  it("refuses every kind of address that a public DNS record cannot use, with the reason", () => {
    const refused: Record<string, RegExp> = {
      "127.0.0.1": /loopback/,
      "127.1.2.3": /loopback/,
      "10.1.2.3": /private/,
      "172.16.0.1": /private/,
      "172.31.255.255": /private/,
      "192.168.1.1": /private/,
      "169.254.1.1": /link-local/,
      "100.64.0.1": /Tailscale/,
      "100.127.255.255": /Tailscale/,
      "0.0.0.0": /unspecified/,
      "224.0.0.1": /multicast/,
      "255.255.255.255": /reserved/,
      "::1": /loopback/,
      "::": /unspecified/,
      "fe80::1": /link-local/,
      "fd12:3456::1": /unique local/,
      "ff02::1": /multicast/,
      "::ffff:10.0.0.1": /private/,
      "::ffff:127.0.0.1": /loopback/,
    };
    for (const [ip, why] of Object.entries(refused)) expect(privateReason(ip), ip).toMatch(why);
  });

  it("accepts routable addresses, including the ones next to the private ranges", () => {
    for (const ip of ["203.0.113.7", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "2606:4700::1111", "2001:db8::1", "::ffff:8.8.8.8"]) {
      expect(privateReason(ip), ip).toBeNull();
    }
  });

  it("says what to do about it", () => {
    const message = privateMessage({ ip: "10.0.0.5", private: "a private network address" });
    expect(message).toContain("10.0.0.5 is a private network address");
    expect(message).toMatch(/public address in its settings/);
    expect(message).toMatch(/split-horizon/);
  });
});

describe("isCloudflareAddress", () => {
  it("knows Cloudflare's IPv4 and IPv6 ranges, and nothing around them", () => {
    for (const ip of ["104.16.0.1", "104.21.55.9", "172.67.12.3", "188.114.97.1", "162.159.1.1", "131.0.72.9", "2606:4700:3030::6815:1", "2a06:98c1::1"]) expect(isCloudflareAddress(ip), ip).toBe(true);
    for (const ip of ["104.15.255.255", "104.32.0.1", "172.63.255.255", "162.160.0.1", "203.0.113.7", "2606:4701::1", "2a06:98c8::1", "not an ip"]) expect(isCloudflareAddress(ip), ip).toBe(false);
  });
});

describe("isHostname", () => {
  it("accepts names a certificate can be issued for", () => {
    for (const ok of ["shop.example.com", "a.b.c.example.co.uk", "xn--bcher-kva.example", "my-app.example.com", "a1.io"]) expect(isHostname(ok), ok).toBe(true);
  });

  it("refuses IP literals, wildcards, single labels, bad labels and upper case", () => {
    for (const bad of ["1.2.3.4", "1.2.3.04", "::1", "[::1]", "*.example.com", "localhost", "-a.example.com", "a-.example.com", "a..example.com", "a.example.com.", "Shop.Example.com", "a b.example.com", `${"a".repeat(64)}.example.com`, `${"a.".repeat(130)}com`, "http://a.example.com", "a.example.com/x"]) {
      expect(isHostname(bad), bad).toBe(false);
    }
  });

  it("cleans a name for comparing", () => {
    expect(cleanHostname("  Shop.Example.COM. ")).toBe("shop.example.com");
  });
});

describe("deriveAddress", () => {
  const never = async (): Promise<string[]> => {
    throw new Error("resolver must not be used");
  };

  it("takes the explicit override before anything else, even over an IP in the URL", async () => {
    const out = await deriveAddress({ url: "https://10.0.0.5:8443", publicIp: "203.0.113.7" }, never);
    expect(out).toEqual({ ok: true, address: { ip: "203.0.113.7", family: 4, source: "override", private: null } });
  });

  it("reads the IP in the agent's URL, IPv4 or IPv6, without resolving", async () => {
    expect(await deriveAddress({ url: "http://203.0.113.9:8443", publicIp: null }, never)).toMatchObject({ ok: true, address: { ip: "203.0.113.9", source: "agent-url" } });
    expect(await deriveAddress({ url: "https://[2001:db8::7]:8443/base", publicIp: null }, never)).toMatchObject({ ok: true, address: { ip: "2001:db8::7", family: 6, source: "agent-url" } });
  });

  it("tells a server that connects out (no URL) to set its public address instead of failing on the URL", async () => {
    expect(await deriveAddress({ url: "", publicIp: null }, never)).toMatchObject({ ok: false, error: expect.stringContaining("public address") });
    expect(await deriveAddress({ url: "", publicIp: "203.0.113.7" }, never)).toMatchObject({ ok: true, address: { ip: "203.0.113.7", source: "override" } });
  });

  it("resolves a host name, IPv4 first, and says it was resolved", async () => {
    const out = await deriveAddress({ url: "https://agent.example.com", publicIp: null }, async (host) => {
      expect(host).toBe("agent.example.com");
      return ["2001:db8::1", "203.0.113.7", "203.0.113.8"];
    });
    expect(out).toMatchObject({ ok: true, address: { ip: "203.0.113.7", family: 4, source: "resolved" } });
  });

  it("uses an AAAA when the name has nothing else", async () => {
    expect(await deriveAddress({ url: "https://agent.example.com", publicIp: null }, async () => ["2001:db8::1"])).toMatchObject({ ok: true, address: { ip: "2001:db8::1", family: 6 } });
    expect(recordType(6)).toBe("AAAA");
    expect(recordType(4)).toBe("A");
  });

  it("flags a private address instead of hiding it", async () => {
    const out = await deriveAddress({ url: "http://127.0.0.1:8443", publicIp: null }, never);
    expect(out).toMatchObject({ ok: true, address: { ip: "127.0.0.1", private: expect.stringContaining("loopback") } });
    const tailnet = await deriveAddress({ url: "https://agent.example.com", publicIp: null }, async () => ["100.101.102.103"]);
    expect(tailnet).toMatchObject({ ok: true, address: { private: expect.stringContaining("Tailscale") } });
  });

  it("explains a host name that does not resolve and an override that is not an address", async () => {
    const lost = await deriveAddress({ url: "https://agent.example.com", publicIp: null }, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(lost).toEqual({ ok: false, error: expect.stringContaining("did not resolve") });
    expect(await deriveAddress({ url: "https://agent.example.com", publicIp: null }, async () => [])).toMatchObject({ ok: false });
    expect(await deriveAddress({ url: "https://a.example.com", publicIp: "my-server" }, never)).toEqual({ ok: false, error: expect.stringContaining("not an IP address") });
  });

  it("describes where the address came from", () => {
    const base = { ip: "1.2.3.4", family: 4 as const, private: null };
    expect(describeSource({ ...base, source: "override" }, "https://x.example.com")).toMatch(/settings/);
    expect(describeSource({ ...base, source: "agent-url" }, "https://1.2.3.4")).toMatch(/agent's URL/);
    expect(describeSource({ ...base, source: "resolved" }, "https://agent.example.com")).toContain("agent.example.com");
  });
});

describe("normalizePublicIp", () => {
  it("accepts empty (derive it) or an address, in canonical form, and nothing else", () => {
    expect(normalizePublicIp("")).toBe("");
    expect(normalizePublicIp("  203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizePublicIp("2001:DB8:0::1")).toBe("2001:db8::1");
    expect(normalizePublicIp("example.com")).toBeNull();
    expect(normalizePublicIp("1.2.3.4/24")).toBeNull();
  });
});
