import { describe, expect, it } from "vitest";
import { normalizeAppsDomain, normalizeUrl, validateServer, type ServerFormValues } from "@/lib/server-input";

const valid: ServerFormValues = {
  name: "vps-1",
  url: "https://agent.example.com",
  token: "t".repeat(32),
  deploySecret: "",
  caCert: "",
  clientCert: "",
  clientKey: "",
};

describe("normalizeUrl", () => {
  it("keeps the origin and path, drops trailing slashes", () => {
    expect(normalizeUrl("https://agent.example.com/")).toBe("https://agent.example.com");
    expect(normalizeUrl(" http://10.0.0.5:7070 ")).toBe("http://10.0.0.5:7070");
    expect(normalizeUrl("https://example.com/keelson/")).toBe("https://example.com/keelson");
  });

  it("refuses anything that is not a plain http(s) base URL", () => {
    for (const bad of ["", "agent.example.com", "ftp://x.com", "javascript:alert(1)", "https://u:p@x.com", "https://x.com/?a=1", "https://x.com/#f"]) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe("validateServer", () => {
  it("accepts a minimal valid server", () => {
    expect(validateServer(valid, false)).toEqual({});
  });

  it("requires a token on creation but lets an edit keep the stored one", () => {
    expect(validateServer({ ...valid, token: "" }, false).token).toBeDefined();
    expect(validateServer({ ...valid, token: "" }, true).token).toBeUndefined();
    expect(validateServer({ ...valid, token: "short" }, true).token).toBeDefined();
  });

  it("holds secrets to a minimum length and keeps the two secrets apart", () => {
    expect(validateServer({ ...valid, deploySecret: "short" }, false).deploySecret).toBeDefined();
    expect(validateServer({ ...valid, deploySecret: valid.token }, false).deploySecret).toBeDefined();
    expect(validateServer({ ...valid, deploySecret: "d".repeat(32) }, false)).toEqual({});
  });

  it("checks name length and PEM shapes", () => {
    expect(validateServer({ ...valid, name: "" }, false).name).toBeDefined();
    expect(validateServer({ ...valid, name: "x".repeat(61) }, false).name).toBeDefined();
    expect(validateServer({ ...valid, caCert: "not a cert" }, false).caCert).toBeDefined();
    expect(validateServer({ ...valid, clientKey: "not a key" }, false).clientKey).toBeDefined();
  });

  it("requires the client certificate and key together on creation", () => {
    const cert = "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----";
    const key = "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----";
    expect(validateServer({ ...valid, clientCert: cert }, false).clientKey).toBeDefined();
    expect(validateServer({ ...valid, clientCert: cert, clientKey: key }, false)).toEqual({});
    // On edit one half may already be stored.
    expect(validateServer({ ...valid, clientCert: cert }, true)).toEqual({});
  });
});

describe("validateServer: the public address", () => {
  it("accepts an empty address (derived from the agent's URL), IPv4 and IPv6", () => {
    for (const publicIp of ["", "203.0.113.7", "2001:db8::7", "  203.0.113.7 "]) expect(validateServer({ ...valid, publicIp }, false).publicIp, publicIp).toBeUndefined();
    expect(validateServer(valid, false).publicIp).toBeUndefined();
  });

  it("refuses a name, a URL, a CIDR and a port", () => {
    for (const publicIp of ["example.com", "https://203.0.113.7", "203.0.113.0/24", "203.0.113.7:443", "999.1.1.1"]) expect(validateServer({ ...valid, publicIp }, false).publicIp, publicIp).toBeDefined();
  });
});

describe("normalizeAppsDomain", () => {
  it("keeps a plain domain in lower case without a trailing dot, and reads an empty text as no domain", () => {
    expect(normalizeAppsDomain("apps.example.com")).toBe("apps.example.com");
    expect(normalizeAppsDomain("  Apps.Example.COM. ")).toBe("apps.example.com");
    expect(normalizeAppsDomain("example.org")).toBe("example.org");
    expect(normalizeAppsDomain("")).toBeNull();
    expect(normalizeAppsDomain("   ")).toBeNull();
  });

  it("refuses what is not a domain name: an address, a URL, a wildcard, a path, a port, one label", () => {
    for (const bad of ["203.0.113.7", "https://apps.example.com", "*.example.com", "apps.example.com/x", "apps.example.com:8443", "localhost", "-a.example.com", "a..example.com", "exa mple.com"]) {
      expect(normalizeAppsDomain(bad), bad).toBeUndefined();
    }
  });
});
