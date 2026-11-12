import { describe, expect, it } from "vitest";
import { CACHE_MAX, CommitInfoCache, FAILURE_PAUSE_MS, LOOKUPS_PER_CALL, type Deps } from "@/lib/commit-info";
import { commitKey, type CommitInfo, type CommitRef } from "@/lib/github-core";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const ref = (n: number, repo = "acme/shop"): CommitRef => ({ repo, sha: sha(n) });
const info = (message: string): CommitInfo => ({ message, author: "ana", date: "2026-10-21T10:00:00Z" });

/** A GitHub that knows the commits it is given (by number) and counts the questions. */
function fake(known: Record<number, string> = {}) {
  const asked: string[] = [];
  let at = 1_000;
  const deps: Deps = {
    async lookup(c) {
      asked.push(c.sha);
      const message = known[Number.parseInt(c.sha, 16)];
      return message === undefined ? null : info(message);
    },
    now: () => at,
  };
  return { deps, asked, advance: (ms: number) => (at += ms) };
}

describe("commit messages", () => {
  it("answers by repository and full hash, whatever the repository's letter case", async () => {
    const { deps } = fake({ 1: "First" });
    const answer = await new CommitInfoCache(deps).lookup([ref(1, "Acme/Shop")]);
    expect(answer).toEqual({ [commitKey("acme/shop", sha(1))]: info("First") });
  });

  it("asks GitHub once for a commit: it never changes", async () => {
    const { deps, asked } = fake({ 1: "First" });
    const cache = new CommitInfoCache(deps);
    await cache.lookup([ref(1), ref(1)]);
    const again = await cache.lookup([ref(1)]);
    expect(asked).toEqual([sha(1)]);
    expect(again[commitKey("acme/shop", sha(1))]?.message).toBe("First");
  });

  it("leaves out a commit that could not be read instead of failing, and does not ask again at once", async () => {
    const { deps, asked, advance } = fake({ 2: "Second" });
    const cache = new CommitInfoCache(deps);
    expect(await cache.lookup([ref(1), ref(2)])).toEqual({ [commitKey("acme/shop", sha(2))]: info("Second") });
    await cache.lookup([ref(1)]);
    expect(asked).toEqual([sha(1), sha(2)]);
    advance(FAILURE_PAUSE_MS + 1);
    await cache.lookup([ref(1)]);
    expect(asked).toEqual([sha(1), sha(2), sha(1)]);
  });

  it("treats a lookup that throws as a commit that could not be read", async () => {
    const cache = new CommitInfoCache({
      lookup: async () => {
        throw new Error("network");
      },
      now: () => 0,
    });
    expect(await cache.lookup([ref(1)])).toEqual({});
  });

  it("asks for a handful of commits per call, the first ones, and the rest on the next call", async () => {
    const all = Object.fromEntries(Array.from({ length: LOOKUPS_PER_CALL + 3 }, (_, i) => [i + 1, `Commit ${i + 1}`]));
    const { deps, asked } = fake(all);
    const cache = new CommitInfoCache(deps);
    const refs = Array.from({ length: LOOKUPS_PER_CALL + 3 }, (_, i) => ref(i + 1));
    expect(Object.keys(await cache.lookup(refs))).toHaveLength(LOOKUPS_PER_CALL);
    expect(asked).toEqual(refs.slice(0, LOOKUPS_PER_CALL).map((r) => r.sha));
    expect(Object.keys(await cache.lookup(refs))).toHaveLength(LOOKUPS_PER_CALL + 3);
  });

  it("keeps a bounded number of answers, dropping the oldest", async () => {
    const all = Object.fromEntries(Array.from({ length: CACHE_MAX + 1 }, (_, i) => [i + 1, `Commit ${i + 1}`]));
    const { deps, asked } = fake(all);
    const cache = new CommitInfoCache(deps);
    for (let i = 1; i <= CACHE_MAX + 1; i++) await cache.lookup([ref(i)]);
    await cache.lookup([ref(CACHE_MAX + 1)]);
    expect(asked).toHaveLength(CACHE_MAX + 1);
    await cache.lookup([ref(1)]);
    expect(asked).toHaveLength(CACHE_MAX + 2);
  });
});
