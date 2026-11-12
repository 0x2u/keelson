/** Pure helpers for the GitHub integration: input checks, reading the API's answers, and joining commits to deployments. */

import { z } from "zod";

const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** "owner/name", or a github.com URL to it, as "owner/name"; null when it is neither. */
export function parseRepo(input: string): string | null {
  let text = input.trim();
  const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(text);
  if (url?.[1]) text = url[1];
  const match = REPO.exec(text);
  if (!match || match[2] === "." || match[2] === ".." || match[2]?.endsWith(".git")) return null;
  return text;
}

export function isBranchName(name: string): boolean {
  return BRANCH.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock");
}

/** The commit a deployment reference points at when its tag is a commit SHA (7 to 40 hex digits), else null. */
export function commitOfRef(ref: string): string | null {
  if (ref.includes("@")) return null; // a digest says nothing about a commit
  const tag = ref.slice(ref.lastIndexOf(":") + 1);
  if (tag === ref || tag.includes("/")) return null;
  return /^[0-9a-f]{7,40}$/.test(tag) ? tag : null;
}

/** The same, only when the tag is the full 40-hex hash (what a build from source tags its image with): the one a commit lookup can use. */
export function fullCommitOfRef(ref: string): string | null {
  const sha = commitOfRef(ref);
  return sha !== null && sha.length === 40 ? sha : null;
}

/** Whether a deployment reference is the commit, which may be given in full or abbreviated. */
export function refIsCommit(ref: string, sha: string): boolean {
  const tag = commitOfRef(ref);
  return tag !== null && sha.startsWith(tag);
}

/** The commit status Keelson writes for a preview, so a pull request shows whether its preview is up. */
export const PREVIEW_STATUS_CONTEXT = "keelson/preview";

/** The commit status Keelson writes while the GitHub App's build of a commit runs, and how it ended. */
export const BUILD_STATUS_CONTEXT = "keelson/build";

export type CommitStatusState = "pending" | "success" | "failure";

/** GitHub accepts at most 140 characters of description, on one line. */
export function statusDescription(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 140 ? line : `${line.slice(0, 139)}…`;
}

export interface Commit {
  sha: string;
  /** The first line of the message. */
  message: string;
  author: string;
  date: string;
  url: string;
}

export type RunState = "success" | "failure" | "running" | "queued" | "cancelled" | "other";

export interface WorkflowRun {
  id: number;
  name: string;
  number: number;
  state: RunState;
  branch: string;
  sha: string;
  event: string;
  startedAt: string;
  url: string;
}

export interface Comparison {
  aheadBy: number;
  behindBy: number;
}

const SHA = /^[0-9a-f]{40}$/;

const CommitItem = z.object({
  sha: z.string().regex(SHA),
  html_url: z.string().optional(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
  }),
  author: z.object({ login: z.string() }).nullish(),
});

const RunItem = z.object({
  id: z.number(),
  head_sha: z.string().regex(SHA),
  name: z.string().nullish(),
  display_title: z.string().nullish(),
  run_number: z.number().optional(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  head_branch: z.string().nullish(),
  event: z.string().optional(),
  run_started_at: z.string().nullish(),
  created_at: z.string().nullish(),
  html_url: z.string().optional(),
});

const Runs = z.object({ workflow_runs: z.array(z.unknown()) });
const Compare = z.object({ ahead_by: z.number(), behind_by: z.number() });
const RepoItem = z.object({ full_name: z.string() });

/** The entries of a list that match the schema; the rest are dropped rather than failing the whole page. */
function valid<T extends z.ZodType>(items: unknown, schema: T): z.infer<T>[] {
  if (!Array.isArray(items)) return [];
  const out: z.infer<T>[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseCommits(json: unknown): Commit[] {
  return valid(json, CommitItem).map((item) => ({
    sha: item.sha,
    message: item.commit.message.split("\n", 1)[0] ?? "",
    author: item.author?.login ?? item.commit.author?.name ?? "",
    date: item.commit.author?.date ?? "",
    url: item.html_url ?? "",
  }));
}

/** What a page shows of a commit it names. */
export type CommitInfo = Pick<Commit, "message" | "author" | "date">;

/** A commit to look up: the repository and the full 40-hex hash (an abbreviated one is not a stable key). */
export interface CommitRef {
  repo: string;
  sha: string;
}

/** Where a commit's info is kept: the repository (any letter case) and the full hash. */
export const commitKey = (repo: string, sha: string): string => `${repo.toLowerCase()}@${sha}`;

/** One commit, as the single-commit endpoint answers (the same shape as an entry of the list); null when it is not what was expected. */
export function parseCommit(json: unknown): Commit | null {
  return parseCommits([json])[0] ?? null;
}

export function runState(status: string, conclusion: string): RunState {
  if (status === "queued" || status === "waiting" || status === "pending" || status === "requested") return "queued";
  if (status !== "completed") return "running";
  if (conclusion === "success") return "success";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "failure";
  return "other";
}

export function parseRuns(json: unknown): WorkflowRun[] {
  const parsed = Runs.safeParse(json);
  if (!parsed.success) return [];
  return valid(parsed.data.workflow_runs, RunItem).map((item) => ({
    id: item.id,
    name: item.name || item.display_title || "",
    number: item.run_number ?? 0,
    state: runState(item.status ?? "", item.conclusion ?? ""),
    branch: item.head_branch ?? "",
    sha: item.head_sha,
    event: item.event ?? "",
    startedAt: item.run_started_at || item.created_at || "",
    url: item.html_url ?? "",
  }));
}

export function parseComparison(json: unknown): Comparison | null {
  const parsed = Compare.safeParse(json);
  return parsed.success ? { aheadBy: parsed.data.ahead_by, behindBy: parsed.data.behind_by } : null;
}

/** What a preview needs to know of a pull request: whether it is still open, and the commit it is at now. */
export interface PullRequestInfo {
  open: boolean;
  merged: boolean;
  headSha: string;
}

const PullRequest = z.object({ state: z.string(), merged: z.boolean().optional(), head: z.object({ sha: z.string() }) });

export function parsePullRequest(json: unknown): PullRequestInfo | null {
  const parsed = PullRequest.safeParse(json);
  if (!parsed.success) return null;
  const { state, merged, head } = parsed.data;
  return { open: state === "open", merged: merged === true, headSha: head.sha.toLowerCase() };
}

const BranchItem = z.object({ name: z.string() });

/** The names of a repository's branches, in the order GitHub gives them, those that cannot be one dropped. */
export function parseBranchNames(json: unknown): string[] {
  return valid(json, BranchItem)
    .map((item) => item.name)
    .filter((name) => isBranchName(name));
}

/** The branch to start from: the default one if the repository has it, else main, master, or the first. Empty without branches. */
export function pickBranch(branches: string[], defaultBranch?: string): string {
  for (const wanted of [defaultBranch, "main", "master"]) if (wanted && branches.includes(wanted)) return wanted;
  return branches[0] ?? "";
}

export function parseRepoNames(json: unknown): string[] {
  return valid(json, RepoItem)
    .map((item) => item.full_name)
    .filter((name) => parseRepo(name) !== null);
}

/**
 * The state of the commit's CI: its runs on that commit, worst first. A failed run wins over a successful one, and an
 * unfinished one over both, so "success" means every run for the commit passed.
 */
export function commitCi(sha: string, runs: WorkflowRun[]): RunState | null {
  const states = runs.filter((r) => r.sha === sha).map((r) => r.state);
  if (states.length === 0) return null;
  for (const wanted of ["failure", "running", "queued", "cancelled", "other"] as const) {
    if (states.includes(wanted)) return wanted;
  }
  return "success";
}

export type CommitDeployment = "serving" | "deploying" | "deployed" | "failed";

/**
 * What happened to a commit on this app, from its deployments (whose tag is the commit): it is serving now, being
 * deployed, was deployed before, or every attempt failed. Null when it was never deployed from here.
 */
export function commitDeployment(sha: string, servingRef: string | null, deployments: { ref: string; status: string }[]): CommitDeployment | null {
  if (servingRef !== null && refIsCommit(servingRef, sha)) return "serving";
  const mine = deployments.filter((d) => refIsCommit(d.ref, sha));
  if (mine.length === 0) return null;
  if (mine.some((d) => d.status === "running")) return "deploying";
  return mine.some((d) => d.status === "succeeded") ? "deployed" : "failed";
}
