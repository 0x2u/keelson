import { describe, expect, it } from "vitest";
import type { Port } from "@/lib/agent-types";
import { isLoopbackHost, localAddress, publishedAddresses, serverHostOf } from "@/lib/published-address-core";

describe("serverHostOf", () => {
  it("is the public address when set, else the host of the agent's URL, else nothing for a server that connects out", () => {
    expect(serverHostOf({ url: "https://agent.example.com:7443", publicIp: "203.0.113.7" })).toBe("203.0.113.7");
    expect(serverHostOf({ url: "https://agent.example.com:7443", publicIp: null })).toBe("agent.example.com");
    expect(serverHostOf({ url: "http://[2001:db8::1]:7443", publicIp: " " })).toBe("2001:db8::1");
    expect(serverHostOf({ url: "", publicIp: null })).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it("knows this machine's own names", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "LOCALHOST"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["203.0.113.7", "agent.example.com", "10.0.0.1"]) expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe("localAddress", () => {
  it("opens a loopback port only from the machine it is on", () => {
    expect(localAddress(8100, true, "localhost")).toEqual({ port: 8100, loopback: true, address: "127.0.0.1:8100", url: "http://127.0.0.1:8100" });
    expect(localAddress(8100, true, "203.0.113.7")).toEqual({ port: 8100, loopback: true, address: "127.0.0.1:8100", url: null });
  });
  it("opens a port that is open to the network at the server's host, bracketing an IPv6 literal", () => {
    expect(localAddress(8100, false, "agent.example.com")).toMatchObject({ address: "agent.example.com:8100", url: "http://agent.example.com:8100" });
    expect(localAddress(8100, false, "2001:db8::1")).toMatchObject({ address: "[2001:db8::1]:8100", url: "http://[2001:db8::1]:8100" });
    expect(localAddress(8100, false, null)).toEqual({ port: 8100, loopback: false, address: ":8100", url: null });
  });
});

describe("publishedAddresses", () => {
  const port = (extra: Partial<Port>): Port => ({ private_port: 80, type: "tcp", ...extra });

  it("is what a container publishes, once per port even when Docker lists IPv4 and IPv6", () => {
    const ports = [port({ ip: "0.0.0.0", public_port: 8100 }), port({ ip: "::", public_port: 8100 }), port({ ip: "127.0.0.1", public_port: 3281 })];
    expect(publishedAddresses(ports, "203.0.113.7").map((a) => [a.address, a.loopback])).toEqual([
      ["127.0.0.1:3281", true],
      ["203.0.113.7:8100", false],
    ]);
  });

  it("ignores what is not published, and what is not tcp", () => {
    expect(publishedAddresses([port({}), port({ ip: "0.0.0.0", public_port: 53, type: "udp" })], "h")).toEqual([]);
    expect(publishedAddresses(null, "h")).toEqual([]);
    expect(publishedAddresses(undefined, "h")).toEqual([]);
  });
});
