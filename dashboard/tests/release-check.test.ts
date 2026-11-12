import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCheckEnabled, updateCheckUrl, RELEASE_CHECK_URL } from "@/lib/env";
import { CHECK_INTERVAL_MS, FAILURE_PAUSE_MS, MANUAL_PAUSE_MS } from "@/lib/release-check-core";
import { ReleaseChecker, type Deps } from "@/lib/release-check";

const LATEST = { tag_name: "v0.2.0", html_url: "https://github.com/0x2u/keelson/releases/tag/v0.2.0", published_at: "2026-11-01T10:00:00Z", prerelease: false, body: "notes" };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A checker on a fake clock whose requests are `fetch`, with the switch and version it is told. */
function setup(fetch: Deps["fetch"], over: Partial<Deps> = {}) {
  const clock = { now: Date.parse("2026-11-02T12:00:00Z") };
  const deps: Deps = { enabled: () => true, url: () => RELEASE_CHECK_URL, version: () => "v0.1.0", fetch, now: () => clock.now, ...over };
  return { checker: new ReleaseChecker(deps), clock };
}

afterEach(() => vi.unstubAllEnvs());

describe("the update check", () => {
  it("finds a newer release and offers it", async () => {
    const fetch = vi.fn(async () => answer(LATEST));
    const { checker } = setup(fetch);
    const check = await checker.current();
    expect(check).toMatchObject({ enabled: true, status: "newer", failed: false, latest: { tag: "v0.2.0" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing about the installation: a User-Agent with the version, no cookie, no credential", async () => {
    const fetch = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => (void args, answer(LATEST)));
    const { checker } = setup(fetch);
    await checker.current();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/0x2u/keelson/releases/latest");
    expect(init?.credentials).toBe("omit");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ Accept: "application/vnd.github+json", "User-Agent": "keelson-dashboard/v0.1.0" });
    expect(init?.body).toBeUndefined();
  });

  it("makes no request at all when the check is off, for a page, the sidebar or Check now", async () => {
    const fetch = vi.fn(async () => answer(LATEST));
    const { checker } = setup(fetch, { enabled: () => false });
    expect(await checker.current()).toEqual({ enabled: false, status: "unknown", latest: null, failed: false, checkedAt: null });
    expect(checker.peek().enabled).toBe(false);
    expect(await checker.checkNow()).toMatchObject({ check: { enabled: false }, limited: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks once a day, whatever the number of pages", async () => {
    const fetch = vi.fn(async () => answer(LATEST));
    const { checker, clock } = setup(fetch);
    await Promise.all([checker.current(), checker.current(), checker.current()]);
    await checker.current();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += CHECK_INTERVAL_MS - 1;
    await checker.current();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await checker.current();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows a network error as a failure without throwing, and does not retry for an hour", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { checker, clock } = setup(fetch);
    expect(await checker.current()).toMatchObject({ enabled: true, status: "unknown", latest: null, failed: true });
    await checker.current();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.now += FAILURE_PAUSE_MS;
    await checker.current();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an error status, a timeout and a body that is not JSON as failures too", async () => {
    for (const reply of [() => answer({ message: "rate limited" }, 403), () => Promise.reject(new DOMException("timed out", "TimeoutError")), () => Promise.resolve(new Response("<html>"))]) {
      const { checker } = setup(vi.fn(async () => reply()));
      expect(await checker.current()).toMatchObject({ failed: true, latest: null });
    }
  });

  it("keeps the last release it found when a later check fails", async () => {
    const replies: (() => Promise<Response>)[] = [async () => answer(LATEST), async () => Promise.reject(new Error("offline"))];
    const { checker, clock } = setup(vi.fn(() => replies.shift()!()));
    await checker.current();
    clock.now += CHECK_INTERVAL_MS;
    expect(await checker.current()).toMatchObject({ status: "newer", failed: true, latest: { tag: "v0.2.0" } });
  });

  it("offers nothing when the latest answer is a pre-release, and does not call it a failure", async () => {
    const { checker } = setup(vi.fn(async () => answer({ ...LATEST, prerelease: true })));
    expect(await checker.current()).toMatchObject({ status: "unknown", latest: null, failed: false });
  });

  it("never nags a build from source", async () => {
    const { checker } = setup(vi.fn(async () => answer(LATEST)), { version: () => "v0.1.0-4-g1a2b3c4" });
    expect((await checker.current()).status).toBe("ahead");
  });

  it("peek answers at once and asks in the background", async () => {
    const gate = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => gate.promise);
    const { checker } = setup(fetch);
    expect(checker.peek()).toMatchObject({ enabled: true, status: "unknown", latest: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve(answer(LATEST));
    await checker.current();
    expect(checker.peek().status).toBe("newer");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets Check now ask again, but once a minute", async () => {
    const fetch = vi.fn(async () => answer(LATEST));
    const { checker, clock } = setup(fetch);
    await checker.current();
    expect((await checker.checkNow()).limited).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.now += MANUAL_PAUSE_MS - 1;
    const early = await checker.checkNow();
    expect(early).toMatchObject({ limited: true, check: { status: "newer" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.now += 1;
    expect((await checker.checkNow()).limited).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("the switch and the development address", () => {
  it("is on unless KEELSON_UPDATE_CHECK says off", () => {
    expect(updateCheckEnabled()).toBe(true);
    for (const off of ["off", "OFF", " off ", "false", "0"]) {
      vi.stubEnv("KEELSON_UPDATE_CHECK", off);
      expect(updateCheckEnabled(), off).toBe(false);
    }
    for (const on of ["on", "true", "1", ""]) {
      vi.stubEnv("KEELSON_UPDATE_CHECK", on);
      expect(updateCheckEnabled(), on).toBe(true);
    }
  });

  it("reads GitHub's address unless KEELSON_UPDATE_CHECK_URL names another (for development)", () => {
    expect(updateCheckUrl()).toBe(RELEASE_CHECK_URL);
    vi.stubEnv("KEELSON_UPDATE_CHECK_URL", " http://127.0.0.1:8099/latest.json ");
    expect(updateCheckUrl()).toBe("http://127.0.0.1:8099/latest.json");
  });
});
