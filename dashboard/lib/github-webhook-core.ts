/**
 * Pure rules of the GitHub webhook: checking GitHub's signature, deciding whether a finished workflow run should
 * deploy, and whether a deployment would put an older commit over a newer one. No database, no network.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Comparison } from "@/lib/github-core";
import { commitOfRef, refIsCommit } from "@/lib/github-core";

/** The largest delivery accepted. GitHub's own limit is 25 MB, but a workflow_run payload is a few tens of KB. */
export const MAX_BODY_BYTES = 1024 * 1024;

export const WEBHOOK_PATH = "/api/webhooks/github";

/** The signature GitHub puts in X-Hub-Signature-256 for a body: "sha256=" and the hex HMAC-SHA256 of the raw bytes. */
export function signBody(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Whether the header is the signature of exactly these bytes under the secret. Constant time; false for any malformed header. */
export function verifySignature(secret: string, body: Uint8Array | string, header: string | null | undefined): boolean {
  if (!header || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const SHA = /^[0-9a-f]{40}$/;

const Repo = z.object({ full_name: z.string() });

/** The part of a `workflow_run` delivery the decision needs. */
export const WorkflowRunPayload = z.object({
  action: z.string(),
  repository: Repo,
  workflow_run: z.object({
    id: z.number().int(),
    run_attempt: z.number().int().positive().nullish(),
    name: z.string().nullish(),
    conclusion: z.string().nullish(),
    event: z.string(),
    head_sha: z.string(),
    head_branch: z.string().nullish(),
    head_repository: Repo.nullish(),
    // The pull requests the run belongs to. GitHub leaves it empty for runs from forks.
    pull_requests: z.array(z.object({ number: z.number().int(), base: z.object({ ref: z.string() }).nullish() })).nullish(),
  }),
});
export type WorkflowRunPayload = z.infer<typeof WorkflowRunPayload>;

/** A finished, successful run of a workflow on a branch of the repository itself: the thing that can trigger a deployment. */
export interface AcceptedRun {
  repo: string;
  branch: string;
  sha: string;
  workflow: string;
  /** Identifies the run itself (repository, run id, attempt), taken from the signed body: every delivery of that run shares it. */
  runKey: string;
}

export type RunDecision = { accepted: true; run: AcceptedRun } | { accepted: false; reason: string };

const PULL_REQUEST_EVENTS: Record<string, true> = { pull_request: true, pull_request_target: true };

/**
 * Whether a run can trigger a deployment at all, whatever is linked: it completed with success, did not come from a
 * pull request or a fork, and names a full commit SHA. The reason is safe to show to the caller.
 */
export function acceptRun(payload: WorkflowRunPayload): RunDecision {
  const run = payload.workflow_run;
  if (payload.action !== "completed") return { accepted: false, reason: "the run has not completed" };
  if (run.conclusion !== "success") return { accepted: false, reason: "the run did not succeed" };
  if (Object.hasOwn(PULL_REQUEST_EVENTS, run.event)) return { accepted: false, reason: "pull request runs never deploy" };
  if (run.head_repository?.full_name.toLowerCase() !== payload.repository.full_name.toLowerCase()) {
    return { accepted: false, reason: "the run comes from a fork" };
  }
  if (!SHA.test(run.head_sha)) return { accepted: false, reason: "the run has no full commit SHA" };
  if (!run.head_branch) return { accepted: false, reason: "the run is not on a branch" };
  if (!run.name) return { accepted: false, reason: "the run has no workflow name" };
  return {
    accepted: true,
    run: {
      repo: payload.repository.full_name,
      branch: run.head_branch,
      sha: run.head_sha,
      workflow: run.name,
      runKey: `${payload.repository.full_name.toLowerCase()}#${run.id}#${run.run_attempt ?? 1}`,
    },
  };
}

/** Present on a delivery of a GitHub App installation: the one thing that says the App, not only the repository's webhook, sent it. */
const Installation = z.object({ id: z.number().int() });

/** The part of a `pull_request` delivery the removal of a preview, and a build of its head, need. */
export const PullRequestPayload = z.object({
  action: z.string(),
  repository: Repo,
  installation: Installation.nullish(),
  pull_request: z.object({
    number: z.number().int(),
    head: z.object({ sha: z.string().nullish(), ref: z.string().nullish(), repo: Repo.nullish() }).nullish(),
    base: z.object({ ref: z.string().nullish(), repo: Repo.nullish() }).nullish(),
  }),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

/** The largest pull request number the agent accepts. */
export const MAX_PULL_REQUEST = 999999;

export function validPullRequest(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_PULL_REQUEST;
}

/** The name of the preview of a pull request of an app, as the agent names it. */
export function previewName(app: string, pr: number): string {
  return `${app}-pr-${pr}`;
}

/** A finished, successful run of a workflow on a pull request of the repository itself: the thing that can create a preview. */
export interface AcceptedPreviewRun {
  repo: string;
  /** The pull request's branch, as the run reports it. */
  headBranch: string | null;
  sha: string;
  workflow: string;
  runKey: string;
  /** The pull requests the run belongs to (valid numbers only), with the branch each merges into. */
  pullRequests: { number: number; base: string | null }[];
}

export type PreviewRunDecision = { accepted: true; run: AcceptedPreviewRun } | { accepted: false; reason: string };

/**
 * Whether a run can create a preview at all, whatever is linked: it completed with success, came from a `pull_request`
 * event (never `pull_request_target`, which runs with the base's secrets), from a branch of the repository itself (no
 * forks), names a full commit SHA, and belongs to at least one pull request. The reason is safe to show to the caller.
 */
export function acceptPreviewRun(payload: WorkflowRunPayload): PreviewRunDecision {
  const run = payload.workflow_run;
  if (payload.action !== "completed") return { accepted: false, reason: "the run has not completed" };
  if (run.conclusion !== "success") return { accepted: false, reason: "the run did not succeed" };
  if (run.event !== "pull_request") return { accepted: false, reason: "only pull_request runs create previews" };
  if (run.head_repository?.full_name.toLowerCase() !== payload.repository.full_name.toLowerCase()) {
    return { accepted: false, reason: "the run comes from a fork" };
  }
  if (!SHA.test(run.head_sha)) return { accepted: false, reason: "the run has no full commit SHA" };
  if (!run.name) return { accepted: false, reason: "the run has no workflow name" };
  const seen = new Set<number>();
  const pullRequests: AcceptedPreviewRun["pullRequests"] = [];
  for (const pr of run.pull_requests ?? []) {
    if (!validPullRequest(pr.number) || seen.has(pr.number)) continue;
    seen.add(pr.number);
    pullRequests.push({ number: pr.number, base: pr.base?.ref ?? null });
  }
  if (pullRequests.length === 0) return { accepted: false, reason: "the run belongs to no pull request" };
  return {
    accepted: true,
    run: {
      repo: payload.repository.full_name,
      headBranch: run.head_branch ?? null,
      sha: run.head_sha,
      workflow: run.name,
      runKey: `${payload.repository.full_name.toLowerCase()}#${run.id}#${run.run_attempt ?? 1}`,
      pullRequests,
    },
  };
}

/** What an app's link says about previews. */
export interface PreviewLink {
  repo: string;
  /** The branch pull requests must merge into. */
  branch: string;
  /** The workflow whose success on a pull request creates its preview; null when previews are off. */
  previewsWorkflow: string | null;
}

/**
 * The pull requests of an accepted run that this link makes a preview for: previews are on, same repository (any
 * case), same workflow name, and the pull request merges into the linked branch.
 */
export function previewPullRequests(link: PreviewLink, run: AcceptedPreviewRun): number[] {
  if (link.previewsWorkflow === null || link.previewsWorkflow !== run.workflow || link.repo.toLowerCase() !== run.repo.toLowerCase()) return [];
  return run.pullRequests.filter((pr) => pr.base === link.branch).map((pr) => pr.number);
}

/**
 * Whether to deploy `sha` to a preview that serves `servingRef`. A preview follows its pull request, which is
 * force-pushed as a matter of course, so unlike an app only a commit GitHub proves older (a run that finished late)
 * or the one already serving is skipped; with no comparison the commit deploys.
 */
export function decidePreviewDeploy(args: { sha: string; servingRef: string | null; comparison: Comparison | null }): DeployDecision {
  if (args.servingRef !== null && refIsCommit(args.servingRef, args.sha)) return { deploy: false, reason: "already serving" };
  const { comparison } = args;
  if (comparison && comparison.aheadBy === 0 && comparison.behindBy > 0) return { deploy: false, reason: "older than what is serving" };
  return { deploy: true };
}

/** What an app's link says about automatic deploys. */
export interface AutoDeployLink {
  repo: string;
  branch: string;
  /** The workflow whose success deploys; null when automatic deploys are off. */
  autoDeployWorkflow: string | null;
}

/** Whether an accepted run is the one this link waits for: same repository (any case), same branch, same workflow name. */
export function linkMatchesRun(link: AutoDeployLink, run: AcceptedRun): boolean {
  return link.autoDeployWorkflow !== null && link.repo.toLowerCase() === run.repo.toLowerCase() && link.branch === run.branch && link.autoDeployWorkflow === run.workflow;
}

export type DeployDecision = { deploy: true } | { deploy: false; reason: string };

/** Why GitHub's compare gave no answer, when it was not available for the decision. */
export type ComparisonProblem = "no_token" | "failed";

/**
 * Whether to deploy `sha` given what the app serves. `comparison` is GitHub's view of `sha` against the serving
 * commit (`aheadBy`: how many commits the new one has over the serving one, `behindBy` the opposite); null when it
 * was not asked or could not be answered, and `problem` says which.
 *
 * A run that finishes late must not roll the app back, so the order is never assumed: when the app serves anything
 * (a commit, a tag, a digest) and the new commit cannot be placed against it (no token, the serving image is not
 * tagged with a commit, the compare failed or timed out) or the histories diverged, the run is skipped with the
 * reason. The one exception is an app that serves nothing yet: its first deployment has nothing to be older than.
 */
export function decideDeploy(args: { sha: string; servingRef: string | null; comparison: Comparison | null; problem?: ComparisonProblem }): DeployDecision {
  if (args.servingRef === null) return { deploy: true };
  if (refIsCommit(args.servingRef, args.sha)) return { deploy: false, reason: "already serving" };
  const { comparison } = args;
  if (comparison) {
    if (comparison.aheadBy > 0 && comparison.behindBy > 0) {
      return { deploy: false, reason: "the history diverged from what is serving (a force push?), so which is newer is unknown" };
    }
    if (comparison.aheadBy === 0 && comparison.behindBy > 0) return { deploy: false, reason: "older than what is serving" };
    return { deploy: true };
  }
  let why: string;
  if (commitOfRef(args.servingRef) === null) why = "the serving image is not tagged with a commit; deploy this commit once from the dashboard to start automatic deploys";
  else if (args.problem === "no_token") why = "no GitHub token is connected to compare the commits";
  else why = "GitHub's comparison of the commits failed or timed out";
  return { deploy: false, reason: `ordering unknown, skipped: ${why}` };
}

/**
 * What a delivery did to an app. `pending`: claimed, being handled right now. `unknown`: the deploy request got no
 * answer in time, so the deployment may have started; it blocks a second deployment of the same commit until the
 * app can be read again.
 */
export type DeliveryOutcome = "pending" | "deployed" | "skipped" | "failed" | "unknown";

/** What a closed pull request did to one preview: removed, or why not. */
export interface RemovalResult {
  server: string;
  app: string;
  outcome: "removed" | "skipped" | "failed" | "unknown";
  detail: string;
}

export interface DeliveryResult {
  server: string;
  app: string;
  outcome: DeliveryOutcome;
  detail: string;
  deployment_id?: string;
}

export interface OriginArgs {
  publicUrl: URL | null;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  trustProxy: boolean;
  secure: boolean;
}

/**
 * Where this dashboard is reached from outside, such as https://keelson.example.com. The configured public URL wins;
 * otherwise the request's own host, with the forwarded one only when a trusted proxy sets it. Null when nothing says
 * where the dashboard is.
 */
export function dashboardOrigin(args: OriginArgs): string | null {
  if (args.publicUrl) return args.publicUrl.origin;
  const host = (args.trustProxy ? args.forwardedHost?.split(",")[0]?.trim() || args.host : args.host)?.trim();
  if (!host || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return null;
  const forwarded = args.forwardedProto?.split(",")[0]?.trim();
  // `secure` (cookies are Secure) says an https proxy is expected in front, not that this address is https: the dashboard
  // itself speaks plain http. On loopback, with no proxy to say otherwise, it is reached directly (a development run, a
  // tunnel), and an https command for it fails in curl with a TLS "protocol version" alert.
  const direct = !args.trustProxy && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = args.trustProxy && (forwarded === "http" || forwarded === "https") ? forwarded : args.secure && !direct ? "https" : "http";
  return `${proto}://${host}`;
}

/** The address to paste into GitHub. */
export function webhookUrl(args: OriginArgs): string | null {
  const origin = dashboardOrigin(args);
  return origin === null ? null : new URL(WEBHOOK_PATH, origin).toString();
}

/** The part of a `push` delivery a build needs. */
export const PushPayload = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().nullish(),
  repository: Repo,
  installation: Installation.nullish(),
});
export type PushPayload = z.infer<typeof PushPayload>;

/** A push of a commit to a branch of a repository the GitHub App is installed on: the thing that can start a build. */
export interface AcceptedPush {
  repo: string;
  branch: string;
  sha: string;
  /** `<repo>#push#<sha>`: every delivery of this push, and a redelivery under a new id, shares it. */
  runKey: string;
}

export type PushDecision = { accepted: true; push: AcceptedPush } | { accepted: false; reason: string };

const BRANCH_REF = "refs/heads/";

/**
 * Whether a push can start a build at all, whatever is linked: it updates a branch (not a tag), does not delete it,
 * names a full commit SHA, and came through an App installation. The reason is safe to show to the caller.
 */
export function acceptPush(payload: PushPayload): PushDecision {
  if (!payload.ref.startsWith(BRANCH_REF) || payload.ref.length === BRANCH_REF.length) return { accepted: false, reason: "the push is not to a branch" };
  if (payload.deleted === true || /^0{40}$/.test(payload.after)) return { accepted: false, reason: "the push deletes the branch" };
  if (!SHA.test(payload.after)) return { accepted: false, reason: "the push has no full commit SHA" };
  if (!payload.installation) return { accepted: false, reason: "the push did not come through the GitHub App" };
  return {
    accepted: true,
    push: {
      repo: payload.repository.full_name,
      branch: payload.ref.slice(BRANCH_REF.length),
      sha: payload.after,
      runKey: `${payload.repository.full_name.toLowerCase()}#push#${payload.after}`,
    },
  };
}

/** A pull request opened or updated from a branch of the repository itself, through the GitHub App: the thing that can start a preview build. */
export interface AcceptedPullBuild {
  repo: string;
  number: number;
  sha: string;
  headBranch: string | null;
  /** The branch the pull request merges into. */
  base: string;
  /** `<repo>#pr<n>#<sha>`. */
  runKey: string;
}

export type PullBuildDecision = { accepted: true; pull: AcceptedPullBuild } | { accepted: false; reason: string };

const BUILD_ACTIONS: Record<string, true> = { opened: true, reopened: true, synchronize: true };

/**
 * Whether a pull request event can start a preview build at all, whatever is linked: opened, reopened or pushed to,
 * with a head commit in the repository itself (a fork, or a head repository that no longer exists, never builds),
 * through an App installation. The reason is safe to show to the caller.
 */
export function acceptPullBuild(payload: PullRequestPayload): PullBuildDecision {
  const { pull_request: pull } = payload;
  if (!Object.hasOwn(BUILD_ACTIONS, payload.action)) return { accepted: false, reason: "only opened, reopened and updated pull requests are built" };
  if (!validPullRequest(pull.number)) return { accepted: false, reason: "the pull request number is out of range" };
  if (!payload.installation) return { accepted: false, reason: "the pull request did not come through the GitHub App" };
  const repo = payload.repository.full_name.toLowerCase();
  const head = pull.head?.repo?.full_name.toLowerCase();
  const baseRepo = pull.base?.repo?.full_name.toLowerCase() ?? repo;
  if (head === undefined || head !== repo || baseRepo !== repo) return { accepted: false, reason: "the pull request comes from a fork" };
  const sha = pull.head?.sha;
  if (!sha || !SHA.test(sha)) return { accepted: false, reason: "the pull request has no full commit SHA" };
  if (!pull.base?.ref) return { accepted: false, reason: "the pull request has no base branch" };
  return {
    accepted: true,
    pull: {
      repo: payload.repository.full_name,
      number: pull.number,
      sha,
      headBranch: pull.head?.ref ?? null,
      base: pull.base.ref,
      runKey: `${repo}#pr${pull.number}#${sha}`,
    },
  };
}

/** What an app's link says about builds from the GitHub App. */
export interface BuildLink {
  repo: string;
  branch: string;
  buildOnPush: boolean;
  buildPreviews: boolean;
}

/** Whether a push is the one this link builds: the mode is on, same repository (any case), same branch. */
export function linkBuildsPush(link: BuildLink, push: AcceptedPush): boolean {
  return link.buildOnPush && link.repo.toLowerCase() === push.repo.toLowerCase() && link.branch === push.branch;
}

/** Whether a pull request is one this link builds a preview for: the mode is on, same repository (any case), merging into the linked branch. */
export function linkBuildsPull(link: BuildLink, pull: AcceptedPullBuild): boolean {
  return link.buildPreviews && link.repo.toLowerCase() === pull.repo.toLowerCase() && link.branch === pull.base;
}

/** Whether a run key belongs to a build started by the GitHub App (a push or a pull request), not to a CI workflow run (`<repo>#<run id>#<attempt>`). */
export function isBuildRunKey(runKey: string | null): boolean {
  return runKey !== null && /#(push|pr[0-9]+)#[0-9a-f]{40}$/.test(runKey);
}
