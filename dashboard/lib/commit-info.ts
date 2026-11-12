import "server-only";
import { githubCommit } from "@/lib/github";
import { commitKey, type CommitInfo, type CommitRef } from "@/lib/github-core";
import { installationToken } from "@/lib/github-app";
import { githubConnection } from "@/lib/integrations";

/** A page names a handful of commits; a few lookups per render are cheap, a hundred are not, and the rest are cached for the next render. */
export const LOOKUPS_PER_CALL = 8;
export const TIMEOUT_MS = 3000;
export const CACHE_MAX = 500;
/** A commit that could not be read is not asked again at once: an unreachable GitHub must not cost three seconds on every render. */
export const FAILURE_PAUSE_MS = 60_000;

export interface Deps {
  lookup(c: CommitRef): Promise<CommitInfo | null>;
  now(): number;
}

/** Minting an installation token has its own, longer, timeout: the whole lookup, token included, gets `TIMEOUT_MS`. */
function withinTimeout<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, TIMEOUT_MS, null);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const defaultDeps: Deps = {
  async lookup({ repo, sha }) {
    try {
      const commit = await withinTimeout(
        (async () => githubCommit(githubConnection()?.token ?? (await installationToken(repo)), repo, sha, TIMEOUT_MS))(),
      );
      return commit && { message: commit.message, author: commit.author, date: commit.date };
    } catch {
      return null;
    }
  },
  now: Date.now,
};

/**
 * Commit messages for pages that name commits. A commit never changes, so an answer is kept (oldest dropped past
 * `CACHE_MAX`); a failure is remembered briefly. Never throws: a commit that cannot be read is simply absent from the answer.
 */
export class CommitInfoCache {
  private readonly known = new Map<string, CommitInfo>();
  private readonly failed = new Map<string, number>();

  constructor(private readonly deps: Deps = defaultDeps) {}

  async lookup(commits: CommitRef[]): Promise<Record<string, CommitInfo>> {
    const answer: Record<string, CommitInfo> = {};
    const missing = new Map<string, CommitRef>();
    const now = this.deps.now();
    for (const c of commits) {
      const key = commitKey(c.repo, c.sha);
      const hit = this.known.get(key);
      if (hit) answer[key] = hit;
      else if (!missing.has(key) && (this.failed.get(key) ?? 0) <= now) missing.set(key, c);
    }
    await Promise.all(
      [...missing].slice(0, LOOKUPS_PER_CALL).map(async ([key, c]) => {
        const info = await this.deps.lookup(c).catch(() => null);
        if (info === null) {
          if (this.failed.size >= CACHE_MAX) this.failed.clear();
          this.failed.set(key, now + FAILURE_PAUSE_MS);
          return;
        }
        this.remember(key, info);
        answer[key] = info;
      }),
    );
    return answer;
  }

  private remember(key: string, info: CommitInfo): void {
    this.known.set(key, info);
    if (this.known.size > CACHE_MAX) this.known.delete(this.known.keys().next().value as string);
  }
}

const shared = new CommitInfoCache();

/** The messages of these commits, as far as GitHub could be asked (see `CommitInfoCache`). */
export const commitInfos = (commits: CommitRef[]): Promise<Record<string, CommitInfo>> => shared.lookup(commits);
