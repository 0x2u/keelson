import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitStatusState } from "@/lib/github-core";
import { GithubError, githubPreviewStatus } from "@/lib/github";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, reportPreview, type StatusDeps } from "@/lib/preview-status";

const SHA = "a".repeat(40);

type Posted = { state: CommitStatusState; description: string; targetUrl?: string };

/** A clock that only moves when the code sleeps, so ten minutes of polling take no time. */
function harness(answers: ("running" | "succeeded" | "failed" | "rolled_back" | Error)[], over: Partial<StatusDeps> = {}) {
  let clock = 1_000_000;
  const posted: Posted[] = [];
  const sleeps: number[] = [];
  let reads = 0;
  const deps: StatusDeps = {
    post: async (state, description, targetUrl) => {
      posted.push({ state, description, ...(targetUrl ? { targetUrl } : {}) });
    },
    deployment: async () => {
      const next = answers[Math.min(reads++, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return { status: next, error: next === "failed" ? "health check failed" : undefined };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { deps, posted, sleeps, reads: () => reads };
}

describe("following a preview deployment on its commit", () => {
  it("posts pending at once, then success with the preview's address when the deployment succeeds", async () => {
    const h = harness(["running", "running", "succeeded"]);
    expect(await reportPreview({ deploymentId: "d1", url: "https://pr-12-shop.example.com" }, h.deps)).toBeNull();
    expect(h.posted).toEqual([
      { state: "pending", description: "Preview deploying" },
      { state: "success", description: "Preview deployed", targetUrl: "https://pr-12-shop.example.com" },
    ]);
    expect(h.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(h.reads()).toBe(3);
  });

  it("posts failure with the deployment's reason when it fails, and without a reason names the status", async () => {
    const failed = harness(["running", "failed"]);
    expect(await reportPreview({ deploymentId: "d1", url: "https://u" }, failed.deps)).toBeNull();
    expect(failed.posted.at(-1)).toEqual({ state: "failure", description: "Preview deploy failed: health check failed" });

    const rolled = harness(["rolled_back"]);
    await reportPreview({ deploymentId: "d1", url: "https://u" }, rolled.deps);
    expect(rolled.posted.at(-1)).toEqual({ state: "failure", description: "Preview deploy failed (rolled_back)" });
  });

  it("gives up after the timeout with a failure that says it did not finish, reading no more after the deadline", async () => {
    const h = harness(["running"]);
    expect(await reportPreview({ deploymentId: "d1", url: "https://u" }, h.deps)).toBeNull();
    expect(h.posted.at(-1)).toEqual({ state: "failure", description: "Preview did not finish deploying in time; check Keelson" });
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(POLL_TIMEOUT_MS);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(POLL_TIMEOUT_MS - 2 * POLL_INTERVAL_MS);
    expect(h.reads()).toBe(h.sleeps.length + 1);
  });

  it("keeps polling through a failed read, and reports it when that is all there was until the deadline", async () => {
    const recovers = harness([new Error("agent down"), "succeeded"]);
    await reportPreview({ deploymentId: "d1", url: "https://u" }, recovers.deps);
    expect(recovers.posted.at(-1)?.state).toBe("success");

    const never = harness([new Error("agent down")], { timeoutMs: 20_000 });
    await reportPreview({ deploymentId: "d1", url: "https://u" }, never.deps);
    expect(never.posted.at(-1)).toEqual({ state: "failure", description: "Could not follow the deployment: agent down" });
  });

  it("honours a pace and a timeout of its own", async () => {
    const h = harness(["running"], { intervalMs: 1000, timeoutMs: 3500 });
    await reportPreview({ deploymentId: "d1", url: "https://u" }, h.deps);
    expect(h.sleeps).toEqual([1000, 1000, 1000]);
  });

  it("says status not reported, and polls nothing, when GitHub refuses the first post", async () => {
    const h = harness(["succeeded"], {
      post: async () => {
        throw new GithubError("The token cannot write commit statuses on this repository", 403);
      },
    });
    expect(await reportPreview({ deploymentId: "d1", url: "https://u" }, h.deps)).toBe("status not reported: The token cannot write commit statuses on this repository");
    expect(h.reads()).toBe(0);
    expect(h.sleeps).toEqual([]);
  });

  it("says status not reported when only the final post is refused", async () => {
    let calls = 0;
    const h = harness(["succeeded"], {
      post: async () => {
        if (++calls === 2) throw new GithubError("GitHub answered with status 500.", 500);
      },
    });
    expect(await reportPreview({ deploymentId: "d1", url: "https://u" }, h.deps)).toBe("status not reported: GitHub answered with status 500.");
  });
});

describe("the commit status request", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(status: number) {
    const fetchMock = vi.fn(async () => new Response(status === 201 ? "{}" : JSON.stringify({ message: "x" }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs state, the keelson/preview context, a one-line description and the target to the commit's statuses, with the token and no caching", async () => {
    const fetchMock = stub(201);
    await githubPreviewStatus("ghp_x", "Acme/Shop", SHA, { state: "success", description: "Preview deployed", targetUrl: "https://pr-1-shop.example.com" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`https://api.github.com/repos/Acme/Shop/statuses/${SHA}`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(String(init.body))).toEqual({ state: "success", context: "keelson/preview", description: "Preview deployed", target_url: "https://pr-1-shop.example.com" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves the target out when there is none", async () => {
    const fetchMock = stub(201);
    await githubPreviewStatus("ghp_x", "a/b", SHA, { state: "pending", description: "Preview deploying" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("target_url");
  });

  it("explains a 403 or 404 as a missing permission, other statuses as GitHub's, and refuses a bad SHA or repository before any request", async () => {
    for (const status of [403, 404]) {
      stub(status);
      await expect(githubPreviewStatus("t", "a/b", SHA, { state: "pending", description: "x" })).rejects.toMatchObject({ status, message: expect.stringContaining("Commit statuses") });
    }
    stub(500);
    await expect(githubPreviewStatus("t", "a/b", SHA, { state: "pending", description: "x" })).rejects.toMatchObject({ status: 500 });
    const fetchMock = stub(201);
    await expect(githubPreviewStatus("t", "a/b", "main", { state: "pending", description: "x" })).rejects.toBeInstanceOf(GithubError);
    await expect(githubPreviewStatus("t", "not a repo", SHA, { state: "pending", description: "x" })).rejects.toBeInstanceOf(GithubError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a network failure into a GithubError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(githubPreviewStatus("t", "a/b", SHA, { state: "pending", description: "x" })).rejects.toMatchObject({ status: 0 });
  });
});
