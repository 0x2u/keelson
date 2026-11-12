import "server-only";
import { z } from "zod";
import {
  BUILD_STATUS_CONTEXT,
  PREVIEW_STATUS_CONTEXT,
  isBranchName,
  parseCommit,
  parseCommits,
  parseComparison,
  parseRepo,
  parseBranchNames,
  parseRepoNames,
  parsePullRequest,
  parseRuns,
  statusDescription,
  type Commit,
  type CommitStatusState,
  type Comparison,
  type PullRequestInfo,
  type WorkflowRun,
} from "@/lib/github-core";

const API = "https://api.github.com";
const TIMEOUT_MS = 8000;
/** How long an answer is reused, so that a page reload does not spend the hourly quota. */
const CACHE_SECONDS = 30;

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

function explain(status: number, remaining: string | null): string {
  switch (status) {
    case 401:
      return "GitHub rejected the token. It may have expired or been revoked: connect a new one in Settings.";
    case 403:
    case 429:
      return remaining === "0"
        ? "GitHub's request limit for this token is used up. It resets within the hour."
        : "The token is not allowed to read this. Give it read access to the repository's contents and Actions.";
    case 404:
      return "GitHub does not know this repository, or the token cannot see it.";
    default:
      return `GitHub answered with status ${status}.`;
  }
}

async function get(token: string, path: string, query: Record<string, string> = {}, fresh = false, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "keelson-dashboard",
      },
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: CACHE_SECONDS } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GithubError("Could not reach api.github.com. Check this server's internet access.", 0);
  }
  if (!res.ok) throw new GithubError(explain(res.status, res.headers.get("x-ratelimit-remaining")), res.status);
  return res.json();
}

const Account = z.object({ login: z.string() });

/** The account a token belongs to; throws GithubError when the token is not accepted. */
export async function githubAccount(token: string): Promise<string> {
  const parsed = Account.safeParse(await get(token, "/user"));
  if (!parsed.success) throw new GithubError("GitHub's answer was not what was expected.", 0);
  return parsed.data.login;
}

/** The repositories the token can see, most recently pushed first. */
export async function githubRepos(token: string): Promise<string[]> {
  return parseRepoNames(await get(token, "/user/repos", { per_page: "100", sort: "pushed", affiliation: "owner,collaborator,organization_member" }));
}

function checkedRepo(repo: string): string {
  const name = parseRepo(repo);
  if (!name) throw new GithubError("That is not a GitHub repository name.", 0);
  return name;
}

function checkedBranch(branch: string): string {
  if (!isBranchName(branch)) throw new GithubError("That is not a valid branch name.", 0);
  return branch;
}

/** The branches of a repository (the first hundred), for choosing the one that gets deployed. */
export async function githubBranches(token: string, repo: string): Promise<string[]> {
  return parseBranchNames(await get(token, `/repos/${checkedRepo(repo)}/branches`, { per_page: "100" }));
}

export async function githubCommits(token: string, repo: string, branch: string): Promise<Commit[]> {
  return parseCommits(await get(token, `/repos/${checkedRepo(repo)}/commits`, { sha: checkedBranch(branch), per_page: "25" }));
}

/** One commit by its full sha; null when GitHub's answer is not what was expected. Throws GithubError. */
export async function githubCommit(token: string, repo: string, sha: string, timeoutMs: number): Promise<Commit | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GithubError("That is not a full commit hash.", 0);
  return parseCommit(await get(token, `/repos/${checkedRepo(repo)}/commits/${sha}`, {}, false, timeoutMs));
}

export async function githubRuns(token: string, repo: string, branch: string): Promise<WorkflowRun[]> {
  return parseRuns(await get(token, `/repos/${checkedRepo(repo)}/actions/runs`, { branch: checkedBranch(branch), per_page: "30" }));
}

/** How far `head` is from `base`; null when GitHub cannot compare them (a commit that was force-pushed away, say). */
export async function githubCompare(token: string, repo: string, base: string, head: string): Promise<Comparison | null> {
  if (!/^[0-9a-f]{7,40}$/.test(base) || !isBranchName(head)) return null;
  try {
    return parseComparison(await get(token, `/repos/${checkedRepo(repo)}/compare/${base}...${encodeURIComponent(head)}`));
  } catch (err) {
    if (err instanceof GithubError && (err.status === 404 || err.status === 422)) return null;
    throw err;
  }
}

/** The state of a pull request right now (never cached); null when GitHub's answer is not what was expected. Throws GithubError. */
export async function githubPullRequest(token: string, repo: string, n: number): Promise<PullRequestInfo | null> {
  if (!Number.isInteger(n) || n < 1) throw new GithubError("That is not a pull request number.", 0);
  return parsePullRequest(await get(token, `/repos/${checkedRepo(repo)}/pulls/${n}`, {}, true));
}

/**
 * Sets a commit status of a commit ("keelson/preview" or "keelson/build"): the one thing Keelson writes to GitHub.
 * Never cached; throws GithubError, whose message says what to change when the token cannot write statuses.
 */
export async function githubCommitStatus(
  token: string,
  repo: string,
  sha: string,
  context: string,
  status: { state: CommitStatusState; description: string; targetUrl?: string },
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GithubError("That is not a full commit SHA.", 0);
  let res: Response;
  try {
    res = await fetch(new URL(`/repos/${checkedRepo(repo)}/statuses/${sha}`, API), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "keelson-dashboard",
      },
      body: JSON.stringify({
        state: status.state,
        context,
        description: statusDescription(status.description),
        ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GithubError("Could not reach api.github.com. Check this server's internet access.", 0);
  }
  if (res.ok) return;
  if (res.status === 403 || res.status === 404) {
    throw new GithubError("The token cannot write commit statuses on this repository: give it \u201cCommit statuses: read and write\u201d (for the GitHub App, accept that permission in its installation).", res.status);
  }
  throw new GithubError(explain(res.status, res.headers.get("x-ratelimit-remaining")), res.status);
}

type CommitStatus = { state: CommitStatusState; description: string; targetUrl?: string };

/** The commit status "keelson/preview" of a preview's commit. */
export const githubPreviewStatus = (token: string, repo: string, sha: string, status: CommitStatus) => githubCommitStatus(token, repo, sha, PREVIEW_STATUS_CONTEXT, status);

/** The commit status "keelson/build" of a commit the GitHub App builds. */
export const githubBuildStatus = (token: string, repo: string, sha: string, status: CommitStatus) => githubCommitStatus(token, repo, sha, BUILD_STATUS_CONTEXT, status);
