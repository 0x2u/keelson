import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressBucket, throttleBucket } from "@/lib/client-ip";
import { totpCode } from "@/lib/auth/totp";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-login-throttle-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// The browser of the test: the cookie it holds (the id of a pending login), and where it connects from.
const browser = { pid: null as string | null, ip: "203.0.113.7", sessions: [] as string[] };
vi.mock("@/lib/session", async () => {
  const store = await import("@/lib/auth/store");
  return {
    clientInfo: async () => ({ ip: browser.ip }),
    pendingLoginId: async () => (browser.pid !== null && store.pendingLoginOpen(browser.pid) ? browser.pid : null),
    finishPendingLogin: async (pid: string) => {
      store.endPendingLogin(pid);
      browser.pid = null;
    },
    startPendingLogin: async () => {
      browser.pid = store.createPendingLogin(5 * 60 * 1000);
    },
    createSession: async (method: string) => {
      browser.sessions.push(method);
      return "session-id";
    },
    destroySession: async () => {},
    requireSession: async () => {},
  };
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { db } = await import("@/lib/db");
const store = await import("@/lib/auth/store");
const { verifySecondFactor } = await import("@/app/actions");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let secret = "";
beforeEach(() => {
  for (const table of ["sessions", "login_failures", "audit_log", "recovery_codes", "pending_logins"]) db().exec(`DELETE FROM ${table}`);
  // One operator, one factor row: start every test unenrolled, then enrol and confirm with the current code.
  db().exec("UPDATE auth_factor SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = -1 WHERE id = 1");
  secret = store.beginTotpSetup();
  store.confirmTotp(totpCode(secret));
  // Confirming used the current step: a login may use it again here.
  db().exec("UPDATE auth_factor SET totp_last_step = -1 WHERE id = 1");
  browser.pid = null;
  browser.ip = "203.0.113.7";
  browser.sessions.length = 0;
});
afterEach(() => vi.useRealTimers());

const form = (code: string) => {
  const f = new FormData();
  f.set("code", code);
  return f;
};

/** A code that is wrong now and in the steps next to it (a code is accepted a step early or late). */
function wrongCode(): string {
  const valid = new Set([-30_000, 0, 30_000].map((d) => totpCode(secret, Date.now() + d)));
  for (let n = 0; n < 1_000_000; n++) {
    const code = String(n).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
  throw new Error("unreachable");
}

/** What the action did: its answer, or the page it redirected to. */
async function verify(code: string): Promise<{ error?: string } | { to: string }> {
  try {
    return await verifySecondFactor({}, form(code));
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") return { to: (err as Error & { to: string }).to };
    throw err;
  }
}

const startLogin = () => {
  browser.pid = store.createPendingLogin(5 * 60 * 1000);
};

describe("the address a throttle counts", () => {
  it("is the /64 of an IPv6 address: any address of a network is the same client", () => {
    expect(addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("is the IPv4 address itself, also when it came wrapped in an IPv6 address, in either spelling", () => {
    expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(addressBucket("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
    expect(addressBucket("64:ff9b::cb00:7107")).toBe("64:ff9b:0:0::/64");
  });

  it("keeps what is not an address, and the prefix of the keys that carry one", () => {
    for (const key of ["local", "unknown", "second-factor:all", "not an address"]) expect(throttleBucket(key)).toBe(key);
    expect(throttleBucket("relay:2001:db8:1:2::9")).toBe("relay:2001:db8:1:2::/64");
    expect(throttleBucket("api:203.0.113.7")).toBe("api:203.0.113.7");
    expect(throttleBucket("setup:abcd::1")).toBe("setup:abcd:0:0:0::/64");
  });
});

describe("the sign-in throttle", () => {
  it("counts an IPv6 network once: five failures from five addresses of a /64 block the sixth address, not another network", () => {
    for (let i = 1; i <= 5; i++) store.recordLoginFailure(`2001:db8:1:2::${i}`);
    expect(store.isLoginBlocked("2001:db8:1:2:dead:beef:0:99")).toBe(true);
    expect(store.isLoginBlocked("2001:db8:1:3::1")).toBe(false);
    store.clearLoginFailures("2001:db8:1:2::77");
    expect(store.isLoginBlocked("2001:db8:1:2::1")).toBe(false);
  });

  it("keeps IPv4 as it was, and the shared bucket of a dashboard behind no trusted proxy as one bucket", () => {
    for (let i = 0; i < 5; i++) store.recordLoginFailure("203.0.113.7");
    expect(store.isLoginBlocked("203.0.113.7")).toBe(true);
    expect(store.isLoginBlocked("203.0.113.8")).toBe(false);
    for (let i = 0; i < 5; i++) store.recordLoginFailure("local");
    expect(store.isLoginBlocked("local")).toBe(true);
    expect(db().prepare("SELECT key FROM login_failures WHERE key = 'local' LIMIT 1").get()).toEqual({ key: "local" });
  });

  it("counts the relay and API buckets the same way, under their own prefix", () => {
    for (let i = 1; i <= 5; i++) store.recordLoginFailure(`relay:2001:db8:5:5::${i}`);
    expect(store.isLoginBlocked("relay:2001:db8:5:5::ffff")).toBe(true);
    expect(store.isLoginBlocked("api:2001:db8:5:5::ffff")).toBe(false);
    expect(store.isLoginBlocked("2001:db8:5:5::ffff")).toBe(false);
  });
});

describe("the attempts of a pending login", () => {
  it("allows five tries, in one statement each, and none after: the same cookie cannot be sent again for more", () => {
    const pid = store.createPendingLogin(60_000);
    const taken = Array.from({ length: 8 }, () => store.takePendingAttempt(pid));
    expect(taken).toEqual([1, 2, 3, 4, 5, null, null, null]);
    expect(store.pendingLoginOpen(pid)).toBe(false);
  });

  it("is gone when it expired, was ended, or never existed", () => {
    const now = Date.now();
    const old = store.createPendingLogin(1000, now - 5000);
    expect(store.pendingLoginOpen(old)).toBe(false);
    expect(store.takePendingAttempt(old)).toBeNull();
    const pid = store.createPendingLogin(60_000);
    store.endPendingLogin(pid);
    expect(store.takePendingAttempt(pid)).toBeNull();
    expect(store.takePendingAttempt("made-up")).toBeNull();
  });
});

describe("the second factor of a sign-in", () => {
  it("is void after five wrong codes on one cookie: the right code on the same cookie no longer works, the password is asked again", async () => {
    startLogin();
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) results.push(await verify(wrongCode()));
    expect(results).toEqual(Array(4).fill({ error: "That code is not valid." }));
    const fifth = await verify(wrongCode());
    // Not a message of the verify form (that page ends with the sign-in and leaves before it shows): the reason travels to the sign-in page.
    expect(fifth).toEqual({ to: "/login?reason=attempts" });
    expect(browser.pid).toBeNull();
    // An attacker that kept the cookie sends the code that would have been right.
    const kept = db().prepare("SELECT COUNT(*) AS n FROM pending_logins").get();
    expect(kept).toEqual({ n: 0 });
    expect(await verify(totpCode(secret))).toEqual({ to: "/login" });
    expect(browser.sessions).toEqual([]);
  });

  it("cannot be replayed with the same cookie beyond its attempts, even when the cookie is kept and sent again", async () => {
    startLogin();
    const kept = browser.pid;
    for (let i = 0; i < 5; i++) await verify(wrongCode());
    browser.pid = kept; // the client holds on to its cookie: the dashboard's row is what counts
    expect(await verify(totpCode(secret))).toEqual({ to: "/login" });
    expect(browser.sessions).toEqual([]);
  });

  it("opens a session on the right code, once: the same cookie cannot open a second", async () => {
    startLogin();
    const kept = browser.pid;
    expect(await verify(wrongCode())).toEqual({ error: "That code is not valid." });
    expect(await verify(totpCode(secret))).toEqual({ to: "/" });
    expect(browser.sessions).toEqual(["password+totp"]);
    browser.pid = kept;
    expect(await verify(totpCode(secret, Date.now() + 30_000))).toEqual({ to: "/login" });
    expect(browser.sessions).toHaveLength(1);
  });

  it("is refused from a network that failed five times, however the addresses inside it change", async () => {
    for (let i = 1; i <= 5; i++) {
      startLogin();
      browser.ip = `2001:db8:9:9:${i}::${i}`;
      await verify(wrongCode());
    }
    startLogin();
    browser.ip = "2001:db8:9:9:ffff::1";
    expect(await verify(totpCode(secret))).toEqual({ error: "Too many failed attempts. Try again in a few minutes." });
    expect(browser.sessions).toEqual([]);
    browser.ip = "2001:db8:9:a::1";
    expect(await verify(totpCode(secret))).toEqual({ to: "/" });
  });

  it("slows every address down once 30 wrong codes came in, and speeds up again as soon as the guessing stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    // Thirty different networks, one wrong code each: no address is near its own limit.
    for (let i = 0; i < 30; i++) {
      startLogin();
      browser.ip = `198.51.${i}.1`;
      expect(await verify(wrongCode()), `wrong code ${i}`).toEqual({ error: "That code is not valid." });
    }
    expect(store.secondFactorWaitMs()).toBe(store.SECOND_FACTOR_SLOWDOWN_MS);
    startLogin();
    browser.ip = "192.0.2.50"; // the operator, who never failed
    const slowed = await verify(totpCode(secret));
    expect(slowed).toMatchObject({ error: expect.stringMatching(/Try again in 30 seconds/) });
    expect(browser.sessions).toEqual([]);
    expect(store.pendingLoginOpen(browser.pid!)).toBe(true); // a refusal costs the pending login nothing

    vi.setSystemTime(new Date(Date.now() + store.SECOND_FACTOR_SLOWDOWN_MS + 1000));
    expect(await verify(totpCode(secret))).toEqual({ to: "/" });
    expect(browser.sessions).toEqual(["password+totp"]);
  });

  it("does not count a right code, and does not slow anyone below the ceiling", async () => {
    for (let i = 0; i < 29; i++) store.recordSecondFactorFailure();
    expect(store.secondFactorWaitMs()).toBe(0);
    startLogin();
    expect(await verify(totpCode(secret))).toEqual({ to: "/" });
    expect(store.secondFactorWaitMs()).toBe(0);
  });
});
