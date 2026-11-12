import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, signToken } from "@/lib/session-token";

const ask = (pathname: string, cookie?: string) =>
  proxy(new NextRequest(`http://dash.example.com${pathname}`, { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} }));

/** Let through: Next.js marks a request the proxy lets continue with this header. */
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

afterEach(() => {
  delete process.env.KEELSON_ALLOWED_IPS;
});

describe("the proxy, without a session", () => {
  it("lets every path under /api/v1 through: each route checks its own bearer token", async () => {
    for (const p of ["/api/v1/servers", "/api/v1/servers/abc/overview", "/api/v1/servers/abc/apps/shop/deploy", "/api/v1/audit", "/api/v1/projects"]) {
      expect(passes(await ask(p)), p).toBe(true);
    }
  });

  it("stops everything else: pages redirect to the sign-in, API calls get a 401", async () => {
    for (const p of ["/", "/servers/abc", "/settings/api-tokens", "/settings/security", "/projects", "/activity"]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    }
    for (const p of [
      "/api/servers/abc/containers/x/logs",
      "/api/servers/abc/deployments/d/events",
      "/api/fleet/health",
      "/api/fleet/search",
      "/api/agent-binary/amd64",
      "/api/v1",
      "/api/v1x/servers",
      "/api/v2/servers",
      "/api/webhooks/github/extra",
      "/api/auth/passkey/register/options",
      "/api/auth/passkey/register/verify",
    ]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
      expect(res.status, p).toBe(401);
    }
  });

  it("lets the relay's routes through, for machines that have no session, and nothing next to them", async () => {
    for (const p of ["/api/relay/enrol", "/api/relay/connect", "/api/relay/binary", "/api/relay/response/0123456789abcdef", "/api/relay/request/0123456789abcdef/body"]) expect(passes(await ask(p)), p).toBe(true);
    for (const p of ["/api/relay", "/api/relay/", "/api/relay/enrol/x", "/api/relay/response", "/api/relay/response/", "/api/relay/response/../servers", "/api/relay/response/a/b", "/api/relay/other", "/api/relay/request", "/api/relay/request/0123456789abcdef", "/api/relay/request/0123456789abcdef/", "/api/relay/request/body", "/api/relay/request/../servers/body", "/api/relay/request/a/b/body", "/api/relay/request/0123456789abcdef/body/x"]) {
      expect(passes(await ask(p)), p).toBe(false);
    }
  });

  it("lets the install script through, for a server that has no session yet, and nothing next to it", async () => {
    expect(passes(await ask("/install"))).toBe(true);
    for (const p of ["/install/", "/install/x", "/installer", "/api/install"]) expect(passes(await ask(p)), p).toBe(false);
  });

  it("does not let a path leave /api/v1 through a dot segment", async () => {
    // The URL parser resolves ".." before the proxy sees the path; what remains must not be let through either.
    for (const p of ["/api/v1/../fleet/health", "/api/v1/%2e%2e/fleet/health", "/api/v1/%2E%2E/servers/abc/containers/x/logs", "/api/v1/./../../settings/api-tokens"]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
    }
    // And a path that keeps a dot segment in what it sends on is refused here, whatever the parser did.
    const { isPublic } = await import("@/proxy");
    for (const p of ["/api/v1/../fleet/health", "/api/v1/%2e%2e/fleet/health", "/api/v1/a/%2E/b", "/api/v1/..", "/api/v1/a\\b"]) expect(isPublic(p), p).toBe(false);
    expect(isPublic("/api/v1/servers/a.b/overview")).toBe(true);
  });

  it("still lets the sign-in pages and the webhook through, and only them", async () => {
    for (const p of ["/login", "/login/verify", "/api/webhooks/github", "/api/auth/passkey/login/options"]) expect(passes(await ask(p)), p).toBe(true);
  });

  it("lets GitHub's return from the App creation through (its handler requires the session itself), and nothing next to it", async () => {
    expect(passes(await ask("/api/github/app/callback?code=abc&state=def"))).toBe(true);
    for (const p of ["/api/github/app/callback/", "/api/github/app/callback/x", "/api/github/app", "/api/github"]) expect(passes(await ask(p)), p).toBe(false);
  });

  it("sends the return from installing the App through one hop on this dashboard (the cookie is SameSite=Strict), then to the sign-in if really signed out", async () => {
    const first = await ask("/settings/integrations?github=installed");
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("url=/settings/integrations?github=installed&#38;hop=1");
    const second = await ask("/settings/integrations?github=installed&hop=1");
    expect(second.status).toBe(307);
    expect(new URL(second.headers.get("location")!).pathname).toBe("/login");
    // Any other address of the page, and any other page, goes straight to the sign-in.
    for (const p of ["/settings/integrations", "/settings/integrations?github=other", "/settings/security?github=installed"]) expect((await ask(p)).status, p).toBe(307);
  });

  it("lets forms post to github.com on the Integrations page only", async () => {
    const formAction = async (p: string) => (await ask(p)).headers.get("content-security-policy")!.split("; ").find((d) => d.startsWith("form-action "));
    const cookie = await signToken("session", { sid: "x" }, 60);
    const withCookie = async (p: string) =>
      (await proxy(new NextRequest(`http://dash.example.com${p}`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }))).headers.get("content-security-policy")!.split("; ").find((d) => d.startsWith("form-action "));
    expect(await withCookie("/settings/integrations")).toBe("form-action 'self' https://github.com");
    expect(await withCookie("/settings/security")).toBe("form-action 'self'");
    expect(await formAction("/login")).toBe("form-action 'self'");
  });
});

describe("the proxy, with a session", () => {
  it("lets pages through", async () => {
    const cookie = await signToken("session", { sid: "x" }, 60);
    expect(passes(await ask("/settings/api-tokens", cookie))).toBe(true);
  });
});

describe("the IP allowlist", () => {
  it("applies to /api/v1 like to everything else", async () => {
    process.env.KEELSON_ALLOWED_IPS = "203.0.113.7";
    process.env.KEELSON_TRUST_PROXY = "true";
    // The allowlist is read once per process: this checks the gate order on a fresh import.
    vi.resetModules();
    const fresh = await import("@/proxy");
    const request = (ip: string) => new NextRequest("http://dash.example.com/api/v1/servers", { headers: { "x-forwarded-for": ip } });
    expect((await fresh.proxy(request("198.51.100.1"))).status).toBe(403);
    expect(passes(await fresh.proxy(request("203.0.113.7")))).toBe(true);
    delete process.env.KEELSON_TRUST_PROXY;
  });
});
