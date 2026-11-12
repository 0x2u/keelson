import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/password";

// Who can reach what while the dashboard has no admin password (setup mode), and after. A fresh process per test, as a real start.

const SAVED = { key: process.env.KEELSON_DASHBOARD_KEY, hash: process.env.KEELSON_ADMIN_PASSWORD_HASH, dir: process.env.KEELSON_DASHBOARD_DATA_DIR };
const dirs: string[] = [];
const holder = globalThis as unknown as { keelsonDb?: { close(): void } };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ hasSession: async () => false, currentSession: async () => null, requireSession: async () => {} }));

async function boot(opts: { hash?: "env" } = {}) {
  holder.keelsonDb?.close();
  delete holder.keelsonDb;
  vi.resetModules();
  const dir = mkdtempSync(path.join(tmpdir(), "keelson-setup-proxy-"));
  dirs.push(dir);
  process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
  delete process.env.KEELSON_DASHBOARD_KEY;
  if (opts.hash === "env") process.env.KEELSON_ADMIN_PASSWORD_HASH = hashPassword("operator-password-1");
  else delete process.env.KEELSON_ADMIN_PASSWORD_HASH;
  const [{ proxy, isPublic }, dbm, sessionToken] = await Promise.all([import("@/proxy"), import("@/lib/db"), import("@/lib/session-token")]);
  const ask = (pathname: string, cookie?: string) =>
    proxy(new NextRequest(`http://dash.example.com${pathname}`, { headers: cookie ? { cookie: `${sessionToken.SESSION_COOKIE}=${cookie}` } : {} }));
  return { ask, isPublic, db: dbm.db };
}

const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

afterAll(() => {
  holder.keelsonDb?.close();
  delete holder.keelsonDb;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const [name, value] of [["KEELSON_DASHBOARD_KEY", SAVED.key], ["KEELSON_ADMIN_PASSWORD_HASH", SAVED.hash], ["KEELSON_DASHBOARD_DATA_DIR", SAVED.dir]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the proxy in setup mode", () => {
  it("lets the setup page through and nothing else", async () => {
    const { ask } = await boot();
    expect(passes(await ask("/setup"))).toBe(true);
    for (const p of ["/", "/login", "/login/verify", "/servers/abc", "/settings/security", "/projects", "/setup/", "/setup/recovery", "/setup/secure", "/setup/recovery/file", "/setupx", "/activity?x=1"]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/setup");
    }
  });

  it("answers machines with 503 instead of a redirect to a page (curl | sh must not run HTML)", async () => {
    const { ask } = await boot();
    for (const p of ["/install", "/api/v1/servers", "/api/relay/enrol", "/api/relay/connect", "/api/webhooks/github", "/api/github/app/callback", "/api/auth/passkey/login/options", "/api/servers/abc/containers/x/logs", "/api/dashboard-backup"]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
      expect(res.status, p).toBe(503);
      expect(await res.text()).toMatch(/not set up yet/);
    }
  });

  it("does not trust a session cookie: there is no password to have signed it", async () => {
    const { ask } = await boot();
    const res = await ask("/", "eyJhbGciOiJIUzI1NiJ9.e30.x");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/setup");
  });

  it("puts the content security policy on every answer", async () => {
    const { ask } = await boot();
    for (const p of ["/setup", "/", "/install"]) expect((await ask(p)).headers.get("content-security-policy"), p).toMatch(/nonce-/);
  });

  it("leaves setup mode in the same process as soon as a password is stored", async () => {
    const { ask, db } = await boot();
    expect((await ask("/")).headers.get("location")).toMatch(/\/setup$/);
    db().prepare("INSERT INTO admin_password (id, hash, created_at) VALUES (1, ?, 1)").run(hashPassword("a password set in the browser"));
    const after = await ask("/");
    expect(new URL(after.headers.get("location")!).pathname).toBe("/login");
    expect((await ask("/install")).status).toBe(200);
  });
});

describe("the proxy once a password exists", () => {
  it("lets the setup page through, for its page to turn away, and keeps its other routes behind a session", async () => {
    const { ask } = await boot({ hash: "env" });
    expect(passes(await ask("/setup"))).toBe(true);
    for (const p of ["/setup/recovery", "/setup/secure", "/setup/recovery/file"]) {
      const res = await ask(p);
      expect(passes(res), p).toBe(false);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/login");
    }
  });

  it("makes /setup the only new public path", async () => {
    const { isPublic } = await boot({ hash: "env" });
    expect(isPublic("/setup")).toBe(true);
    for (const p of ["/setup/", "/setup/recovery", "/setup/recovery/file", "/setup/secure", "/setup/x", "/setupx", "/Setup"]) expect(isPublic(p), p).toBe(false);
  });

  it("does not read the database for it: nothing is opened", async () => {
    const { ask } = await boot({ hash: "env" });
    await ask("/");
    await ask("/setup");
    expect(holder.keelsonDb).toBeUndefined();
  });
});

describe("the pages", () => {
  it("send the sign-in to the setup while there is no password, and the setup to the sign-in once there is one", async () => {
    await boot();
    const login = await import("@/app/login/page");
    const setup = await import("@/app/setup/page");
    await expect(login.default({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT /setup");
    expect(() => setup.default()).not.toThrow();

    await boot({ hash: "env" });
    const setupAfter = await import("@/app/setup/page");
    expect(() => setupAfter.default()).toThrow("REDIRECT /login");
    const loginAfter = await import("@/app/login/page");
    await expect(loginAfter.default({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();

    // The sign-in page says why a cancelled second factor sent the visitor back to the password, and says nothing otherwise.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const plain = renderToStaticMarkup(await loginAfter.default({ searchParams: Promise.resolve({}) }));
    const cancelled = renderToStaticMarkup(await loginAfter.default({ searchParams: Promise.resolve({ reason: "attempts" }) }));
    expect(plain).not.toContain("That sign-in was cancelled");
    expect(cancelled).toContain("That sign-in was cancelled");
    expect(cancelled).toContain("Five wrong verification codes");
  });

  it("send the recovery screen to the sign-in without a session", async () => {
    await boot();
    const recovery = await import("@/app/setup/recovery/page");
    await expect(recovery.default()).rejects.toThrow("REDIRECT /login");
  });
});
