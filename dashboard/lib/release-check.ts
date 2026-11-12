import "server-only";
import { dashboardVersion } from "@/lib/agent-binaries";
import { updateCheckEnabled, updateCheckUrl } from "@/lib/env";
import { CHECK_INTERVAL_MS, FAILURE_PAUSE_MS, MANUAL_PAUSE_MS, parseLatestRelease, releaseStatus, type Release, type ReleaseCheck } from "@/lib/release-check-core";

export const TIMEOUT_MS = 5000;
/** GitHub's answer for one release is a few kilobytes; anything larger is not what was asked for. */
const MAX_BODY_CHARS = 1_000_000;

export interface Deps {
  enabled(): boolean;
  url(): string;
  version(): string;
  fetch: typeof fetch;
  now(): number;
}

const defaultDeps: Deps = { enabled: updateCheckEnabled, url: updateCheckUrl, version: dashboardVersion, fetch: (input, init) => fetch(input, init), now: Date.now };

interface Known {
  latest: Release | null;
  failed: boolean;
  checkedAt: number;
  /** Until when this answer stands (a day after a success, an hour after a failure). */
  validUntil: number;
}

/**
 * The newest release of Keelson, asked of GitHub at most once a day and kept in memory (a restart asks again). The request
 * carries no cookie, no credential and no identifier: a User-Agent naming this dashboard's version, which GitHub requires, and
 * the address it is made from. Nothing about the servers or projects is sent. With the check off no request is ever made.
 * A failure never throws: it is remembered for an hour and reported as `failed`.
 */
export class ReleaseChecker {
  private known: Known | null = null;
  private inflight: Promise<void> | null = null;
  private lastForced = -Infinity;

  constructor(private readonly deps: Deps = defaultDeps) {}

  private view(): ReleaseCheck {
    if (!this.deps.enabled()) return { enabled: false, status: "unknown", latest: null, failed: false, checkedAt: null };
    const k = this.known;
    return { enabled: true, status: releaseStatus(this.deps.version(), k?.latest ?? null), latest: k?.latest ?? null, failed: k?.failed ?? false, checkedAt: k?.checkedAt ?? null };
  }

  private stale(): boolean {
    return this.known === null || this.deps.now() >= this.known.validUntil;
  }

  /** One request at a time: callers that arrive meanwhile share it. */
  private refresh(): Promise<void> {
    this.inflight ??= this.ask().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async ask(): Promise<void> {
    const now = this.deps.now();
    try {
      const res = await this.deps.fetch(this.deps.url(), {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `keelson-dashboard/${this.deps.version()}` },
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("answer too large");
      const body: unknown = JSON.parse(text);
      // A pre-release or a draft is not an error: there is just nothing to offer, until a release is published.
      this.known = { latest: parseLatestRelease(body), failed: false, checkedAt: now, validUntil: now + CHECK_INTERVAL_MS };
    } catch {
      this.known = { latest: this.known?.latest ?? null, failed: true, checkedAt: now, validUntil: now + FAILURE_PAUSE_MS };
    }
  }

  /** The check as it stands, asking GitHub first when the answer is older than a day (an hour after a failure). */
  async current(): Promise<ReleaseCheck> {
    if (this.deps.enabled() && this.stale()) await this.refresh();
    return this.view();
  }

  /** The check as it stands, without waiting: a stale answer starts a request in the background for the next call. */
  peek(): ReleaseCheck {
    if (this.deps.enabled() && this.stale()) void this.refresh();
    return this.view();
  }

  /**
   * "Check now": asks again whatever the answer's age, but only once a minute; inside that minute the answer already held is
   * returned with `limited`.
   */
  async checkNow(): Promise<{ check: ReleaseCheck; limited: boolean }> {
    if (!this.deps.enabled()) return { check: this.view(), limited: false };
    const now = this.deps.now();
    if (now - this.lastForced < MANUAL_PAUSE_MS) return { check: this.view(), limited: true };
    this.lastForced = now;
    await this.refresh();
    return { check: this.view(), limited: false };
  }
}

// One checker per process: server components and actions may be bundled separately, and dev reloads re-evaluate modules.
const slot = globalThis as typeof globalThis & { __keelsonReleaseChecker?: ReleaseChecker };
const shared = (): ReleaseChecker => (slot.__keelsonReleaseChecker ??= new ReleaseChecker());

/** The latest release and how the running dashboard stands against it, asking GitHub when the answer is stale. */
export const releaseCheck = (): Promise<ReleaseCheck> => shared().current();

/** The same without waiting for GitHub (for the sidebar, which every page renders). */
export const releaseCheckSoon = (): ReleaseCheck => shared().peek();

/** "Check now" (see `ReleaseChecker.checkNow`). */
export const checkReleaseNow = (): Promise<{ check: ReleaseCheck; limited: boolean }> => shared().checkNow();
