import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";

describe("content security policy", () => {
  const csp = contentSecurityPolicy("abc123");
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

  it("allows scripts only with the response's nonce, and never inline or eval", () => {
    expect(directive("script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
  });

  it("forbids framing, plugins and foreign form targets", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
  });

  it("lets a page post forms to extra targets only when asked (Connect GitHub posts the App manifest to github.com)", () => {
    expect(contentSecurityPolicy("n", false, ["https://github.com"]).split("; ").find((d) => d.startsWith("form-action "))).toBe("form-action 'self' https://github.com");
    expect(contentSecurityPolicy("n")).not.toContain("github.com");
  });

  it("allows eval only in development", () => {
    expect(contentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
  });

  it("makes a different unguessable nonce every time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
