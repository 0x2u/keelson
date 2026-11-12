import { describe, expect, it } from "vitest";
import { parseAllowlist } from "@/lib/ip-allow";

describe("IP allowlist", () => {
  const list = parseAllowlist("203.0.113.7, 10.0.0.0/8 ,2001:db8::/32");

  it("allows listed addresses and ranges, in both families", () => {
    expect(list.allows("203.0.113.7")).toBe(true);
    expect(list.allows("10.200.3.4")).toBe(true);
    expect(list.allows("2001:db8:1::5")).toBe(true);
  });

  it("refuses everything else, including look-alikes and garbage", () => {
    expect(list.allows("203.0.113.8")).toBe(false);
    expect(list.allows("11.0.0.1")).toBe(false);
    expect(list.allows("2001:db9::1")).toBe(false);
    for (const bad of ["", "unknown", "local", "10.0.0.1, 8.8.8.8", "999.1.1.1"]) expect(list.allows(bad), bad).toBe(false);
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 one", () => {
    expect(list.allows("::ffff:203.0.113.7")).toBe(true);
    expect(list.allows("::ffff:203.0.113.9")).toBe(false);
  });

  it("rejects a malformed list instead of guessing", () => {
    for (const bad of ["", " , ", "not-an-ip", "10.0.0.0/33", "10.0.0.0/x", "10.0.0.0/8/8", "::1/129"]) {
      expect(() => parseAllowlist(bad), JSON.stringify(bad)).toThrow(/KEELSON_ALLOWED_IPS/);
    }
  });
});
