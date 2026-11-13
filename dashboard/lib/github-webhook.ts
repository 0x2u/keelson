import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { AgentError, agentFor, type AgentClient } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import type { BuildSource, Deployment } from "@/lib/agent-types";
import { publicUrl } from "@/lib/env";
import { requestIp } from "@/lib/client-ip";
import { GithubError, githubBuildStatus, githubCompare, githubPreviewStatus, githubPullRequest } from "@/lib/github";
import { GithubAppError, installationToken } from "@/lib/github-app";
import { tarballUrl } from "@/lib/github-app-core";
import { commitOfRef, refIsCommit, type CommitStatusState, type Comparison, type PullRequestInfo } from "@/lib/github-core";
import {
  MAX_BODY_BYTES,
  PullRequestPayload,
  PushPayload,
  WorkflowRunPayload,
  acceptPreviewRun,
  acceptPullBuild,
  acceptPush,
  acceptRun,
  decideDeploy,
  decidePreviewDeploy,
  linkBuildsPull,
  linkBuildsPush,
  linkMatchesRun,
  previewName,
  previewPullRequests,
  validPullRequest,
  verifySignature,
  type AcceptedPreviewRun,
  type AcceptedPullBuild,
  type AcceptedPush,
  type AcceptedRun,
  type ComparisonProblem,
  type DeployDecision,
  type DeliveryResult,
  type RemovalResult,
} from "@/lib/github-webhook-core";
import { autoDeployLinks, buildLinks, getAppRepo, githubAppSummary, githubConnection, previewLinks, webhookSecret } from "@/lib/integrations";
import { ImageTransfer, type BuilderAgent, type TargetAgent, type TransferDeps } from "@/lib/build-transfer";
import { BUILD_POLL_INTERVAL_MS, BUILD_POLL_TIMEOUT_MS, reportBuild, reportPreviewDeployment, type StatusDeps } from "@/lib/preview-status";
import { buildRequestFor, limitRefusal } from "@/lib/build-elsewhere-core";
import { getCredentials, type ServerCredentials } from "@/lib/servers";
import { MANUAL_REPEAT_MS, annotateDelivery, claimDelivery, failBuild, findDelivery, findUnknown, recordDelivery, type Claim, type DeliveryRow } from "@/lib/webhook-deliveries";

/** What the webhook needs from outside the dashboard: the agents and GitHub's compare. Replaced in tests. */
export interface WebhookDeps {
  agent(server: ServerCredentials): Pick<AgentClient, "apps" | "deploy">;
  compare(token: string, repo: string, base: string, head: string): Promise<Comparison | null>;
  /** Time for the agent's app lookup, per target (default 3 s). */
  budgetMs?: number;
  /** The pull request's state right now (default: GitHub's API); a closed one, or one past the run's commit, gets no preview. */
  pullRequest?(token: string, repo: string, n: number): Promise<PullRequestInfo | null>;
  /** Time for that check, run alongside the agent's lookup (default 3 s). */
  pullRequestBudgetMs?: number;
  /** Time for GitHub's compare, its own, not what the lookup left over (default 3 s). */
  compareBudgetMs?: number;
  /** Time for the agent to accept the deploy request (default 3 s). */
  deployBudgetMs?: number;
  /** The agent's previews API (default: the same client as `agent`). */
  previewAgent?(server: ServerCredentials): Pick<AgentClient, "previews" | "deployPreview" | "deletePreview" | "deployment">;
  /** Writes the commit status of a preview (default: GitHub's API). */
  postStatus?(token: string, repo: string, sha: string, status: { state: CommitStatusState; description: string; targetUrl?: string }): Promise<void>;
  /** The agent's build API, and what it needs to tell a build's progress (default: the same client as `agent`). */
  buildAgent?(server: ServerCredentials): Pick<AgentClient, "apps" | "previews" | "build" | "buildPreview" | "deployment" | "config" | "system">;
  /** The build server of an app that is built elsewhere than where it runs: its system report (limits), build request and image export (default: the same client as `agent`). */
  builderAgent?(server: ServerCredentials): Pick<AgentClient, "system" | "startBuild" | "deployment" | "exportImageByRef">;
  /** The server that runs such an app: its image import and deploy (default: the same client as `agent`). */
  transferAgent?(server: ServerCredentials): TargetAgent;
  /** The pace and staging of the image's journey between the two (default: real time). */
  transferDeps?: Partial<TransferDeps>;
  /** A token that reads and writes the repository as the GitHub App (default: minted from the stored App credentials). */
  installationToken?(repo: string): Promise<string>;
  /** Writes the `keelson/build` commit status (default: GitHub's API). */
  postBuildStatus?(token: string, repo: string, sha: string, status: { state: CommitStatusState; description: string; targetUrl?: string }): Promise<void>;
  /** Where the dashboard is reachable, to link a build's status to its deployment page (default: KEELSON_PUBLIC_URL). */
  publicUrl?(): URL | null;
  /** Time for GitHub to mint the installation token (default 3 s), run alongside the agent's lookup. */
  tokenBudgetMs?: number;
  /** Runs work that outlives the answer (default: Next's `after`, which keeps the process on it after the response). */
  background?(task: () => Promise<void>): void;
  /** Waiting and the clock of the status follow-up, and its pace (defaults: real time, 5 s, 10 min). */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** GitHub gives up on a delivery after 10 s: the three steps in sequence (3 + 3 + 3 s) stay under that. */
const LOOKUP_BUDGET_MS = 3000;
const COMPARE_BUDGET_MS = 3000;
const DEPLOY_BUDGET_MS = 3000;
/** Runs alongside the lookup, so the answer stays within the 9 s above. */
const PULL_REQUEST_BUDGET_MS = 3000;
/** Minting the installation token runs alongside the lookup, so the build path is token + (check or compare) + request, all within 9 s. */
const TOKEN_BUDGET_MS = 3000;

export const defaultDeps: WebhookDeps = { agent: agentFor, compare: githubCompare };

const defaultBackground = (task: () => Promise<void>) => after(task);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The raw bytes of the body, or null when it is larger than the limit (the stream is dropped, not buffered further). */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function isJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/json";
}

/** Thrown when the agent (or GitHub) did not answer within the budget. */
class BudgetError extends Error {}

/** The promise's value, or a BudgetError once `ms` have passed; the late answer is ignored. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  const late = Promise.withResolvers<never>();
  const timer = setTimeout(() => late.reject(new BudgetError("did not answer in time")), Math.max(ms, 0));
  return Promise.race([promise, late.promise]).finally(() => clearTimeout(timer));
}

function describeAgentError(err: unknown): string {
  if (err instanceof BudgetError) return "the agent did not answer in time";
  if (!(err instanceof AgentError)) return "unexpected error talking to the agent";
  if (err.status === 409) return "a deployment is already running";
  if (err.status === 0) return err.message;
  if (err.status === 401 || err.status === 403) return "the agent refused the request: check the server's deploy secret";
  return `the agent refused the deployment: ${err.message.slice(0, 200)}`;
}

/**
 * How GitHub places `sha` against what is serving: the comparison, or why there is none. Only asked when the serving
 * image is tagged with another commit; GitHub gets its own budget.
 */
async function placeAgainstServing(token: string | null, repo: string, servingRef: string | null, sha: string, deps: WebhookDeps): Promise<{ comparison: Comparison | null; problem?: ComparisonProblem }> {
  const servingSha = servingRef === null ? null : commitOfRef(servingRef);
  if (servingRef === null || servingSha === null || refIsCommit(servingRef, sha)) return { comparison: null };
  if (token === null) return { comparison: null, problem: "no_token" };
  let comparison: Comparison | null = null;
  try {
    comparison = await within(deps.compare(token, repo, servingSha, sha), deps.compareBudgetMs ?? COMPARE_BUDGET_MS);
  } catch {
    // comparison stays null
  }
  return comparison === null ? { comparison, problem: "failed" } : { comparison };
}

/** The delivery rows of one app on one server: what is stored for it, and how an outcome is written and answered. */
function recorder(link: { serverId: string; app: string }, run: { repo: string; branch: string; sha: string; runKey: string }, deliveryId: string, label: string) {
  const resultOf = (row: DeliveryRow): DeliveryResult => ({
    server: label,
    app: link.app,
    outcome: row.outcome,
    detail: row.detail,
    ...(row.deploymentId ? { deployment_id: row.deploymentId } : {}),
  });
  const finish = (outcome: DeliveryResult["outcome"], detail: string, deploymentId?: string): DeliveryResult => {
    const entry = { deliveryId, repo: run.repo, branch: run.branch, sha: run.sha, serverId: link.serverId, app: link.app, outcome, detail, deploymentId: deploymentId ?? null, runKey: run.runKey };
    try {
      return resultOf(recordDelivery(entry));
    } catch (err) {
      // A deployment that was asked for stays reported even when the log cannot be written.
      console.error("webhook: could not record the delivery outcome:", err);
      return resultOf({ ...entry, at: Date.now() });
    }
  };
  return { resultOf, finish };
}

const HELD_BY_BUILD = "a GitHub App build of this commit has started deploying it";

/** What one linked app does with an accepted run. The outcome is recorded here, once. */
async function deployTo(link: { serverId: string; app: string }, run: AcceptedRun, deliveryId: string, deps: WebhookDeps): Promise<DeliveryResult> {
  const server = getCredentials(link.serverId);
  const { resultOf, finish } = recorder(link, run, deliveryId, server?.name ?? link.serverId);

  // The stored row is the truth: a `deployed` one is never replaced by a later failure, so the answer is what is stored.
  const prior = findDelivery(deliveryId, link.serverId, link.app);
  if (prior?.outcome === "deployed") return resultOf(prior); // a redelivery of what already deployed: nothing to ask anyone

  if (!server) return finish("failed", "the server is not registered in this dashboard");
  if (!server.canDeploy) return finish("failed", "this server has no deploy secret in the dashboard");

  const agent = deps.agent(server);
  let servingRef: string | null;
  try {
    const apps = await within(agent.apps(), deps.budgetMs ?? LOOKUP_BUDGET_MS);
    if (apps === null) return finish("failed", "deployments are not enabled on this server");
    const status = apps.find((a) => a.name === link.app);
    if (!status) return finish("failed", "the app is not on this server");
    servingRef = status.container?.image ?? null;
  } catch (err) {
    // An earlier deploy request that may have started stands until the app can be read: failing now would hide it.
    const earlier = findUnknown(deliveryId, link.serverId, link.app, run.sha);
    if (earlier) return finish("unknown", `an earlier deployment of this commit may have started and the app cannot be read to tell (${describeAgentError(err)})`);
    return finish("failed", describeAgentError(err));
  }

  // The app can be read: claim it before any decision that leads to a deployment. Whoever loses (a concurrent or
  // repeated delivery, or another delivery of the same run or commit) reports what the winner has or is doing.
  const claim = claimDelivery({ deliveryId, repo: run.repo, branch: run.branch, sha: run.sha, serverId: link.serverId, app: link.app, runKey: run.runKey });
  if (!claim.claimed) {
    if (claim.heldByBuild) return finish("skipped", HELD_BY_BUILD);
    const { existing } = claim;
    if (existing.outcome === "pending") return { ...resultOf(existing), detail: "another delivery of this commit is being handled" };
    return resultOf(existing);
  }

  // Out-of-order runs must not roll the app back: ask GitHub how the new commit stands against the serving one,
  // within a budget of its own. Whatever it cannot place is skipped, not deployed (see decideDeploy).
  let decision: DeployDecision;
  try {
    const placed = await placeAgainstServing(githubConnection()?.token ?? null, run.repo, servingRef, run.sha, deps);
    decision = decideDeploy({ sha: run.sha, servingRef, ...placed });
  } catch (err) {
    // The claim must not be left pending: nothing was deployed.
    console.error("webhook: could not decide on a deployment:", err);
    return finish("failed", "unexpected error deciding whether to deploy");
  }
  if (!decision.deploy) return finish("skipped", decision.reason);

  try {
    const deploymentId = await within(agent.deploy(link.app, { tag: run.sha, ...(run.committedAt === undefined ? {} : { committed_at: run.committedAt }) }), deps.deployBudgetMs ?? DEPLOY_BUDGET_MS);
    return finish("deployed", "deployment started", deploymentId);
  } catch (err) {
    // No answer in time says nothing about whether the request got through: it may have started.
    if (err instanceof BudgetError) return finish("unknown", "the agent did not answer the deploy request in time; the deployment may have started");
    return finish("failed", describeAgentError(err));
  }
}

function describePreviewError(err: unknown): string {
  if (err instanceof AgentError && err.status === 404) return "the agent has no preview template for this app (or is too old for previews)";
  if (err instanceof AgentError && err.status === 503) return "the agent is shutting down";
  return describeAgentError(err);
}

/** What the pull request's state says about a run: a reason to skip it, or a note on what could not be checked (previews are low risk, so those proceed). */
interface PullCheck {
  skip?: string;
  note?: string;
}

async function checkPullRequest(token: string | null, run: { repo: string; sha: string }, pr: number, deps: WebhookDeps): Promise<PullCheck> {
  if (token === null) return { note: "pull request state not checked: no GitHub token is connected" };
  try {
    const info = await within((deps.pullRequest ?? githubPullRequest)(token, run.repo, pr), deps.pullRequestBudgetMs ?? PULL_REQUEST_BUDGET_MS);
    if (info === null) return { note: "pull request state not checked: GitHub's answer was not what was expected" };
    if (!info.open) return { skip: "pull request is closed" };
    if (info.headSha !== run.sha.toLowerCase()) return { skip: `the pull request is now at ${info.headSha.slice(0, 7)}: a newer push has its own run` };
    return {};
  } catch (err) {
    if (err instanceof BudgetError) return { note: "pull request state not checked: GitHub did not answer in time" };
    return { note: `pull request state not checked: ${err instanceof GithubError ? err.message : "unexpected error"}` };
  }
}

/** What one linked app does with one pull request of an accepted run: creates or deploys its preview again. Recorded under the preview's name. */
async function deployPreviewTo(link: { serverId: string; app: string; branch: string }, pr: number, run: AcceptedPreviewRun, deliveryId: string, deps: WebhookDeps): Promise<DeliveryResult> {
  const name = previewName(link.app, pr);
  const server = getCredentials(link.serverId);
  const { resultOf, finish } = recorder({ serverId: link.serverId, app: name }, { repo: run.repo, branch: run.headBranch ?? link.branch, sha: run.sha, runKey: run.runKey }, deliveryId, server?.name ?? link.serverId);

  const prior = findDelivery(deliveryId, link.serverId, name);
  if (prior?.outcome === "deployed") return resultOf(prior);

  if (!server) return finish("failed", "the server is not registered in this dashboard");
  if (!server.canDeploy) return finish("failed", "this server has no deploy secret in the dashboard");

  const agent = (deps.previewAgent ?? agentFor)(server);
  const token = githubConnection()?.token ?? null;
  // Alongside the agent's lookup, so it adds no time to the answer. Never rejects: what it could not check becomes a note.
  const pull = checkPullRequest(token, run, pr, deps);
  let servingRef: string | null;
  try {
    const previews = await within(agent.previews(), deps.budgetMs ?? LOOKUP_BUDGET_MS);
    if (previews === null) return finish("failed", "previews are not available on this server");
    // A preview whose last deployment failed serves nothing new: the same commit is tried again.
    const instance = previews.find((p) => p.name === name);
    servingRef = instance && instance.status !== "failed" ? instance.ref : null;
  } catch (err) {
    const earlier = findUnknown(deliveryId, link.serverId, name, run.sha);
    if (earlier) return finish("unknown", `an earlier deployment of this commit may have started and the previews cannot be read to tell (${describePreviewError(err)})`);
    return finish("failed", describePreviewError(err));
  }

  const pullState = await pull;
  if (pullState.skip) return finish("skipped", pullState.skip);

  const claim = claimDelivery({ deliveryId, repo: run.repo, branch: run.headBranch ?? link.branch, sha: run.sha, serverId: link.serverId, app: name, runKey: run.runKey });
  if (!claim.claimed) {
    if (claim.heldByBuild) return finish("skipped", HELD_BY_BUILD);
    const { existing } = claim;
    if (existing.outcome === "pending") return { ...resultOf(existing), detail: "another delivery of this commit is being handled" };
    return resultOf(existing);
  }

  let decision: DeployDecision;
  try {
    const servingSha = servingRef === null ? null : commitOfRef(servingRef);
    let comparison: Comparison | null = null;
    // Only to tell a run that finished late from a newer push: without a token the commit simply deploys.
    if (token !== null && servingRef !== null && servingSha !== null && !refIsCommit(servingRef, run.sha)) {
      try {
        comparison = await within(deps.compare(token, run.repo, servingSha, run.sha), deps.compareBudgetMs ?? COMPARE_BUDGET_MS);
      } catch {
        // comparison stays null
      }
    }
    decision = decidePreviewDeploy({ sha: run.sha, servingRef, comparison });
  } catch (err) {
    console.error("webhook: could not decide on a preview:", err);
    return finish("failed", "unexpected error deciding whether to deploy");
  }
  if (!decision.deploy) return finish("skipped", decision.reason);

  let started;
  try {
    started = await within(agent.deployPreview(link.app, pr, run.sha), deps.deployBudgetMs ?? DEPLOY_BUDGET_MS);
  } catch (err) {
    if (err instanceof BudgetError) return finish("unknown", "the agent did not answer the deploy request in time; the deployment may have started");
    return finish("failed", describePreviewError(err));
  }

  const evicted = started.evicted.length > 0 ? `, evicted ${started.evicted.join(", ")}` : "";
  const detail = `preview deployment started: ${started.url}${evicted}${pullState.note ? ` (${pullState.note})` : ""}`;
  if (token === null) return finish("deployed", `${detail} (status not reported: no GitHub token is connected)`, started.deployment_id);

  const result = finish("deployed", detail, started.deployment_id);
  followPreview({ token: async () => token, repo: run.repo, sha: run.sha, deliveryId, serverId: link.serverId, name, deploymentId: started.deployment_id, url: started.url }, agent, deps);
  return result;
}

/** What the status follow-up reads: an agent's deployment record, or the journey of an image between two servers. */
type DeploymentSource = { deployment(id: string): Promise<Pick<Deployment, "status" | "error">> };

/** The token that writes a status, asked for at each post: a build can outlast the token it started with. */
type TokenSource = () => Promise<string>;

/** What a status follow-up of one deployment is about. */
interface FollowJob {
  repo: string;
  sha: string;
  deliveryId: string;
  serverId: string;
  /** The app or preview the delivery was recorded under. */
  name: string;
  deploymentId: string;
  token: TokenSource;
  /** The server whose page shows `deploymentId` when it is not `serverId` (the build server of an app built elsewhere). */
  watchServerId?: string;
}

/** Runs `task` after the answer; a scheduler that fails is only logged. */
function inBackground(task: () => Promise<void>, deps: WebhookDeps): void {
  try {
    (deps.background ?? defaultBackground)(task);
  } catch (err) {
    console.error("webhook: could not schedule the status report:", err);
  }
}

function noteDelivery(job: FollowJob, note: string | null): void {
  if (note === null) return;
  try {
    annotateDelivery(job.deliveryId, job.serverId, job.name, note);
  } catch (err) {
    console.error("webhook: could not note the status outcome:", err);
  }
}

/** A build that failed frees its commit; what could not be followed to the end leaves the delivery as it is. */
function settleDelivery(job: FollowJob, failed: string | null): void {
  if (failed === null) return;
  try {
    failBuild(job.deliveryId, job.serverId, job.name, failed);
  } catch (err) {
    console.error("webhook: could not record the failed build:", err);
  }
}

function statusDepsOf(job: FollowJob, agent: DeploymentSource, deps: WebhookDeps, post: NonNullable<WebhookDeps["postStatus"]>, pace: { intervalMs: number; timeoutMs: number } | null): StatusDeps {
  return {
    post: async (state, description, targetUrl) => post(await job.token(), job.repo, job.sha, { state, description, targetUrl }),
    deployment: (id) => agent.deployment(id),
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now ?? Date.now,
    intervalMs: deps.pollIntervalMs ?? pace?.intervalMs,
    timeoutMs: deps.pollTimeoutMs ?? pace?.timeoutMs,
  };
}

/**
 * After the answer: puts the preview deployment's progress on the commit as a status, and notes in the delivery what
 * could not be reported. `build`: the deployment includes the agent's build, whose failure frees the commit.
 */
function followPreview(job: FollowJob & { url: string }, agent: Pick<AgentClient, "deployment">, deps: WebhookDeps, build = false): void {
  const statusDeps = statusDepsOf(job, agent, deps, deps.postStatus ?? githubPreviewStatus, build ? { intervalMs: BUILD_POLL_INTERVAL_MS, timeoutMs: BUILD_POLL_TIMEOUT_MS } : null);
  inBackground(async () => {
    const followed = await reportPreviewDeployment({ deploymentId: job.deploymentId, url: job.url, building: build }, statusDeps);
    noteDelivery(job, followed.note);
    if (build) settleDelivery(job, followed.failed);
  }, deps);
}

/** After the answer: puts the build's progress on the commit as the `keelson/build` status, linking the deployment page when the dashboard knows its address. */
function followBuild(job: FollowJob, agent: DeploymentSource, deps: WebhookDeps): void {
  const statusDeps = statusDepsOf(job, agent, deps, deps.postBuildStatus ?? githubBuildStatus, { intervalMs: BUILD_POLL_INTERVAL_MS, timeoutMs: BUILD_POLL_TIMEOUT_MS });
  let deploymentUrl: string | undefined;
  try {
    const base = (deps.publicUrl ?? publicUrl)();
    if (base) deploymentUrl = new URL(`/servers/${encodeURIComponent(job.watchServerId ?? job.serverId)}/deployments/${encodeURIComponent(job.deploymentId)}`, base.origin).toString();
  } catch {
    // an unusable address: the status goes without a link
  }
  inBackground(async () => {
    const followed = await reportBuild({ deploymentId: job.deploymentId, deploymentUrl }, statusDeps);
    noteDelivery(job, followed.note);
    settleDelivery(job, followed.failed);
  }, deps);
}

/** What a closed pull request does to one app's preview of it: removes it. Idempotent on the agent, so nothing is claimed. */
async function removePreviewFrom(link: { serverId: string; app: string }, pr: number, deps: WebhookDeps): Promise<RemovalResult> {
  const server = getCredentials(link.serverId);
  const name = previewName(link.app, pr);
  const result = (outcome: RemovalResult["outcome"], detail: string): RemovalResult => ({ server: server?.name ?? link.serverId, app: name, outcome, detail });
  if (!server) return result("failed", "the server is not registered in this dashboard");
  if (!server.canDeploy) return result("failed", "this server has no deploy secret in the dashboard");
  try {
    await within((deps.previewAgent ?? agentFor)(server).deletePreview(link.app, pr), deps.deployBudgetMs ?? DEPLOY_BUDGET_MS);
    return result("removed", "preview removed (it did not exist if there was none)");
  } catch (err) {
    if (err instanceof BudgetError) return result("unknown", "the agent did not answer in time; the preview may have been removed");
    if (err instanceof AgentError && err.status === 404) return result("skipped", describePreviewError(err));
    return result("failed", describePreviewError(err));
  }
}

// ---- GitHub App builds ----

type BuildAgent = ReturnType<NonNullable<WebhookDeps["buildAgent"]>>;

/** The installation token for the repository, never throwing: what failed is a message that says what to change (and never holds a token). */
async function mintToken(repo: string, deps: WebhookDeps): Promise<{ token: string } | { error: string }> {
  try {
    return { token: await within((deps.installationToken ?? installationToken)(repo), deps.tokenBudgetMs ?? TOKEN_BUDGET_MS) };
  } catch (err) {
    if (err instanceof BudgetError) return { error: "GitHub did not answer in time while creating the GitHub App's installation token" };
    if (err instanceof GithubAppError) return { error: err.message };
    return { error: "unexpected error creating the GitHub App's installation token" };
  }
}

/** The agent's refusal of a build, said for the delivery's detail. */
function describeBuildError(err: unknown, kind: "app" | "preview"): string {
  if (err instanceof AgentError) {
    if (err.status === 404) return kind === "app" ? "the app is not on this server, or the agent is too old to build" : describePreviewError(err);
    if (err.status === 400) return `the agent cannot build this ${kind === "app" ? "app" : "preview"}: ${err.message.slice(0, 200)}`;
    if (err.status === 409) return "a deployment or build is already running on the agent";
    if (err.status === 503) return "the agent is shutting down";
  }
  return describeAgentError(err);
}

/** What a build request came to: the deployment to watch, on the server that builds, and the journey of the image when that is not the server that runs the app. */
interface Submitted {
  deploymentId: string;
  /** The server that builds (the page of `deploymentId`). */
  serverId: string;
  transfer: ImageTransfer | null;
}

/** The build cannot be routed: the build server of an app built elsewhere is unknown, cannot be driven from here or refuses the build. */
class RouteError extends Error {}

/**
 * Asks for the build of `sha`: on the app's own server, or, when the app is built on another server, as a build request to
 * that server (`POST /v1/builds`: the app's `build:` block read from the app's own server, no app there), with the journey of
 * the image back to the app's server prepared. Throws what the agent throws (BudgetError, AgentError) and RouteError.
 */
async function submitBuild(link: { serverId: string; app: string }, server: ServerCredentials, agent: BuildAgent, sha: string, source: BuildSource, deps: WebhookDeps, committedAt?: string): Promise<Submitted> {
  const budget = deps.deployBudgetMs ?? DEPLOY_BUDGET_MS;
  const buildOn = getAppRepo(link.serverId, link.app)?.buildOn ?? null;
  if (buildOn === null) return { deploymentId: await within(agent.build(link.app, sha, source, committedAt), budget), serverId: link.serverId, transfer: null };

  const builder = getCredentials(buildOn);
  if (!builder) throw new RouteError("the build server is not registered in this dashboard");
  if (!builder.canDeploy) throw new RouteError("the build server has no deploy secret in the dashboard");
  const builderAgent = (deps.builderAgent ?? agentFor)(builder);
  let read;
  try {
    read = await within(Promise.all([agent.config(), agent.system(), builderAgent.system()]), deps.budgetMs ?? LOOKUP_BUDGET_MS);
  } catch (err) {
    if (err instanceof BudgetError) throw new RouteError(`${server.name} or ${builder.name} did not answer in time`);
    throw new RouteError(`${server.name} or ${builder.name} could not be read: ${describeAgentError(err)}`);
  }
  const [doc, targetSystem, builderSystem] = read;
  const app = doc?.model.apps?.find((a) => a.name === link.app);
  if (!app) throw new RouteError(`${link.app} is not in ${server.name}'s apps file, so its build: block cannot be read`);
  if (builderSystem === null) throw new RouteError(`${builder.name} does not answer`);
  if (builderSystem.build?.enabled !== true) throw new RouteError(`update the agent on ${builder.name}: it cannot build for other servers yet`);
  const made = buildRequestFor(app, { sha, source, targetArch: targetSystem?.arch, builderArch: builderSystem.arch, builder: { name: builder.name, limits: builderSystem.build.limits } });
  if (!made.ok) throw new RouteError(made.error);
  const refused = limitRefusal(made.request.build, builderSystem.build.limits);
  if (refused !== null) throw new RouteError(`${builder.name} refuses this build: ${refused}`);

  const deploymentId = await within(builderAgent.startBuild(made.request), budget);
  const transfer = new ImageTransfer(
    { builder: builderAgent satisfies BuilderAgent, image: made.request.image, buildDeploymentId: deploymentId, target: (deps.transferAgent ?? agentFor)(server), targetApp: link.app, tag: sha },
    { sleep: deps.sleep ?? defaultSleep, now: deps.now ?? Date.now, pollMs: deps.pollIntervalMs, ...deps.transferDeps },
  );
  return { deploymentId, serverId: builder.id, transfer };
}

/** After the answer: follows the build's status on the commit; for an app built elsewhere also runs the image's journey, and says how it ended. */
function followSubmitted(job: FollowJob, submitted: Submitted, agent: BuildAgent, buildServerName: string, deps: WebhookDeps): void {
  if (submitted.transfer === null) {
    followBuild(job, agent, deps);
    return;
  }
  const transfer = submitted.transfer;
  inBackground(async () => {
    const end = await transfer.run();
    const where = `${job.name} <- ${job.repo}@${job.sha.slice(0, 7)}, built on ${buildServerName}`;
    try {
      if (end.phase === "done") audit("build_transferred", `${where}, deployment ${end.targetDeploymentId}`);
      else audit("build_transfer_failed", `${where}: ${end.error ?? "unknown"}`);
    } catch (err) {
      console.error("webhook: could not record the image's journey:", err);
    }
    noteDelivery(job, end.phase === "done" ? `image sent and deployed (deployment ${end.targetDeploymentId})` : `the image did not reach the server that runs the app: ${end.error ?? "unknown"}`);
  }, deps);
  followBuild({ ...job, deploymentId: submitted.deploymentId, watchServerId: submitted.serverId }, transfer, deps);
}

/** What one linked app does with an accepted push: the agent builds the commit and deploys it. Recorded under the app's name. */
async function buildTo(link: { serverId: string; app: string }, push: AcceptedPush, deliveryId: string, deps: WebhookDeps): Promise<DeliveryResult> {
  const server = getCredentials(link.serverId);
  const { resultOf, finish } = recorder(link, push, deliveryId, server?.name ?? link.serverId);

  const prior = findDelivery(deliveryId, link.serverId, link.app);
  if (prior?.outcome === "deployed") return resultOf(prior);

  if (githubAppSummary() === null) return finish("failed", "the GitHub App is not configured in this dashboard");
  if (!server) return finish("failed", "the server is not registered in this dashboard");
  if (!server.canDeploy) return finish("failed", "this server has no deploy secret in the dashboard");
  const source = tarballUrl(push.repo, push.sha);
  if (source === null) return finish("failed", "that is not a repository and commit GitHub can serve");

  const agent: BuildAgent = (deps.buildAgent ?? agentFor)(server);
  const minted = mintToken(push.repo, deps); // alongside the lookup, so it adds no time to the answer
  let servingRef: string | null;
  try {
    const apps = await within(agent.apps(), deps.budgetMs ?? LOOKUP_BUDGET_MS);
    if (apps === null) return finish("failed", "deployments are not enabled on this server");
    const status = apps.find((a) => a.name === link.app);
    if (!status) return finish("failed", "the app is not on this server");
    servingRef = status.container?.image ?? null;
  } catch (err) {
    const earlier = findUnknown(deliveryId, link.serverId, link.app, push.sha);
    if (earlier) return finish("unknown", `an earlier build of this commit may have started and the app cannot be read to tell (${describeAgentError(err)})`);
    return finish("failed", describeAgentError(err));
  }
  const minting = await minted;
  if ("error" in minting) return finish("failed", minting.error);

  const claim = claimDelivery({ deliveryId, repo: push.repo, branch: push.branch, sha: push.sha, serverId: link.serverId, app: link.app, runKey: push.runKey });
  if (!claim.claimed) return lostClaim(claim, resultOf, finish);

  // The same ordering rules as the workflow path, with the App's token: a commit that cannot be placed against what serves is skipped.
  let decision: DeployDecision;
  try {
    decision = decideDeploy({ sha: push.sha, servingRef, ...(await placeAgainstServing(minting.token, push.repo, servingRef, push.sha, deps)) });
  } catch (err) {
    console.error("webhook: could not decide on a build:", err);
    return finish("failed", "unexpected error deciding whether to build");
  }
  if (!decision.deploy) return finish("skipped", decision.reason);

  let submitted: Submitted;
  try {
    submitted = await submitBuild(link, server, agent, push.sha, { url: source, token: minting.token } satisfies BuildSource, deps, push.committedAt);
  } catch (err) {
    if (err instanceof BudgetError) return finish("unknown", "the agent did not answer the build request in time; the build may have started");
    if (err instanceof RouteError) return finish("failed", err.message);
    return finish("failed", describeBuildError(err, "app").split(minting.token).join("[redacted]"));
  }
  const result = finish("deployed", submitted.transfer ? "build started on the build server; its image will be sent to this server and deployed" : "build and deployment started", submitted.deploymentId);
  followSubmitted({ repo: push.repo, sha: push.sha, deliveryId, serverId: link.serverId, name: link.app, deploymentId: submitted.deploymentId, token: () => (deps.installationToken ?? installationToken)(push.repo) }, submitted, agent, buildServerNameOf(submitted, server), deps);
  return result;
}

function buildServerNameOf(submitted: Submitted, server: ServerCredentials): string {
  return submitted.transfer === null ? server.name : (getCredentials(submitted.serverId)?.name ?? submitted.serverId);
}

/** What a build started from the dashboard came to: the deployment to watch, or why it did not start. */
export type BuildStartResult = { ok: true; deploymentId: string; serverId: string } | { ok: false; error: string };

/**
 * Builds and deploys one commit of a repository on the dashboard's request (the first build of an app added from a
 * repository, or a Deploy click), the way a push does: the same installation token, the same agent request,
 * the delivery recorded under the app (so the Source page lists it and a push of the same commit does not build it
 * twice) and the `keelson/build` status followed in the background. Never throws.
 */
export async function startBuild(link: { serverId: string; app: string }, run: { repo: string; branch: string; sha: string }, deps: WebhookDeps = defaultDeps): Promise<BuildStartResult> {
  const server = getCredentials(link.serverId);
  const push = { repo: run.repo, branch: run.branch, sha: run.sha, runKey: `${run.repo.toLowerCase()}#push#${run.sha}` };
  const deliveryId = `dashboard-build:${randomUUID()}`;
  const { finish } = recorder(link, push, deliveryId, server?.name ?? link.serverId);
  const failed = (error: string): BuildStartResult => {
    finish("failed", error);
    return { ok: false, error };
  };

  if (githubAppSummary() === null) return failed("the GitHub App is not configured in this dashboard");
  if (!server) return failed("the server is not registered in this dashboard");
  if (!server.canDeploy) return failed("this server has no deploy secret in the dashboard");
  const source = tarballUrl(run.repo, run.sha);
  if (source === null) return failed("that is not a repository and commit GitHub can serve");

  const minting = await mintToken(run.repo, deps);
  if ("error" in minting) return failed(minting.error);

  const claim = claimDelivery({ deliveryId, repo: run.repo, branch: run.branch, sha: run.sha, serverId: link.serverId, app: link.app, runKey: push.runKey }, Date.now(), MANUAL_REPEAT_MS);
  if (!claim.claimed) {
    if (claim.existing.outcome === "deployed" && claim.existing.deploymentId) return { ok: true, deploymentId: claim.existing.deploymentId, serverId: getAppRepo(link.serverId, link.app)?.buildOn ?? link.serverId };
    return { ok: false, error: "another build of this commit is being handled; wait for it, then retry" };
  }

  const agent: BuildAgent = (deps.buildAgent ?? agentFor)(server);
  let submitted: Submitted;
  try {
    submitted = await submitBuild(link, server, agent, run.sha, { url: source, token: minting.token } satisfies BuildSource, deps);
  } catch (err) {
    if (err instanceof BudgetError) {
      const error = "the agent did not answer the build request in time; the build may have started: look at the app's deployments before retrying";
      finish("unknown", error);
      return { ok: false, error };
    }
    if (err instanceof RouteError) return failed(err.message);
    return failed(describeBuildError(err, "app").split(minting.token).join("[redacted]"));
  }
  finish("deployed", submitted.transfer ? "build started on the build server from the dashboard; its image will be sent to this server and deployed" : "build and deployment started from the dashboard", submitted.deploymentId);
  followSubmitted({ repo: run.repo, sha: run.sha, deliveryId, serverId: link.serverId, name: link.app, deploymentId: submitted.deploymentId, token: () => (deps.installationToken ?? installationToken)(run.repo) }, submitted, agent, buildServerNameOf(submitted, server), deps);
  return { ok: true, deploymentId: submitted.deploymentId, serverId: submitted.serverId };
}

/** What a lost claim answers: a build of the commit that holds it, or whatever the winner has or is doing. */
function lostClaim(claim: Extract<Claim, { claimed: false }>, resultOf: (row: DeliveryRow) => DeliveryResult, finish: (outcome: DeliveryResult["outcome"], detail: string) => DeliveryResult): DeliveryResult {
  if (claim.heldByBuild) return finish("skipped", HELD_BY_BUILD);
  if (claim.existing.outcome === "pending") return { ...resultOf(claim.existing), detail: "another delivery of this commit is being handled" };
  return resultOf(claim.existing);
}

/** What one linked app does with one accepted pull request: the agent builds the head commit and deploys it as the pull request's preview. Recorded under the preview's name. */
async function buildPreviewTo(link: { serverId: string; app: string; branch: string }, pull: AcceptedPullBuild, deliveryId: string, deps: WebhookDeps): Promise<DeliveryResult> {
  const name = previewName(link.app, pull.number);
  const server = getCredentials(link.serverId);
  const run = { repo: pull.repo, branch: pull.headBranch ?? link.branch, sha: pull.sha, runKey: pull.runKey };
  const { resultOf, finish } = recorder({ serverId: link.serverId, app: name }, run, deliveryId, server?.name ?? link.serverId);

  const prior = findDelivery(deliveryId, link.serverId, name);
  if (prior?.outcome === "deployed") return resultOf(prior);

  if (githubAppSummary() === null) return finish("failed", "the GitHub App is not configured in this dashboard");
  if (!server) return finish("failed", "the server is not registered in this dashboard");
  if (!server.canDeploy) return finish("failed", "this server has no deploy secret in the dashboard");
  const source = tarballUrl(pull.repo, pull.sha);
  if (source === null) return finish("failed", "that is not a repository and commit GitHub can serve");

  const agent: BuildAgent = (deps.buildAgent ?? agentFor)(server);
  const minted = mintToken(pull.repo, deps);
  // As soon as the token exists, alongside the agent's lookup: is the pull request still open, at this commit?
  const state: Promise<PullCheck> = minted.then((m) => ("token" in m ? checkPullRequest(m.token, pull, pull.number, deps) : { note: "pull request state not checked: no installation token" }));
  let servingRef: string | null;
  try {
    const previews = await within(agent.previews(), deps.budgetMs ?? LOOKUP_BUDGET_MS);
    if (previews === null) return finish("failed", "previews are not available on this server");
    const instance = previews.find((p) => p.name === name);
    servingRef = instance && instance.status !== "failed" ? instance.ref : null;
  } catch (err) {
    const earlier = findUnknown(deliveryId, link.serverId, name, pull.sha);
    if (earlier) return finish("unknown", `an earlier build of this commit may have started and the previews cannot be read to tell (${describePreviewError(err)})`);
    return finish("failed", describePreviewError(err));
  }
  const minting = await minted;
  if ("error" in minting) return finish("failed", minting.error);
  const pullState = await state;
  if (pullState.skip) return finish("skipped", pullState.skip);

  const claim = claimDelivery({ deliveryId, repo: run.repo, branch: run.branch, sha: run.sha, serverId: link.serverId, app: name, runKey: run.runKey });
  if (!claim.claimed) return lostClaim(claim, resultOf, finish);

  // The pull request's own head was just checked: only a preview that already serves this commit is skipped.
  const decision = decidePreviewDeploy({ sha: pull.sha, servingRef, comparison: null });
  if (!decision.deploy) return finish("skipped", decision.reason);

  let started;
  try {
    started = await within(agent.buildPreview(link.app, pull.number, pull.sha, { url: source, token: minting.token }), deps.deployBudgetMs ?? DEPLOY_BUDGET_MS);
  } catch (err) {
    if (err instanceof BudgetError) return finish("unknown", "the agent did not answer the build request in time; the build may have started");
    return finish("failed", describeBuildError(err, "preview").split(minting.token).join("[redacted]"));
  }
  const evicted = started.evicted.length > 0 ? `, evicted ${started.evicted.join(", ")}` : "";
  const result = finish("deployed", `preview build and deployment started: ${started.url}${evicted}${pullState.note ? ` (${pullState.note})` : ""}`, started.deployment_id);
  followPreview(
    { repo: pull.repo, sha: pull.sha, deliveryId, serverId: link.serverId, name, deploymentId: started.deployment_id, url: started.url, token: () => (deps.installationToken ?? installationToken)(pull.repo) },
    agent,
    deps,
    true,
  );
  return result;
}

function auditDelivery(request: Request, detail: string): void {
  try {
    audit("webhook_delivery", detail, requestIp(request));
  } catch (err) {
    // The deployments were already asked for: a log that cannot be written must not turn them into an error answer.
    console.error("webhook: could not write the audit line:", err);
  }
}

/** A finished run of a pull request's workflow: creates or deploys again the preview of that pull request in every linked app that wants it. */
async function handlePreviewRun(request: Request, payload: WorkflowRunPayload, deps: WebhookDeps): Promise<Response> {
  const decision = acceptPreviewRun(payload);
  if (!decision.accepted) return reply({ ok: true, ignored: decision.reason, results: [] });
  const run = decision.run;

  const targets = previewLinks(run.repo).flatMap((link) => previewPullRequests(link, run).map((pr) => ({ link, pr })));
  if (targets.length === 0) return reply({ ok: true, ignored: "no app has previews for this run", results: [] });

  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return reply({ error: "missing or invalid X-GitHub-Delivery header" }, 400);

  const settled = await Promise.allSettled(targets.map(({ link, pr }) => deployPreviewTo(link, pr, run, deliveryId, deps)));
  const results: DeliveryResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { server: targets[i]!.link.serverId, app: previewName(targets[i]!.link.app, targets[i]!.pr), outcome: "failed", detail: "unexpected error handling this preview" },
  );
  auditDelivery(request, `${run.repo}@${run.sha.slice(0, 7)} (${run.workflow}, preview): ${results.map((r) => `${r.server}/${r.app} ${r.outcome}`).join(", ")}`);
  return reply({ results });
}

/** A push: builds and deploys the commit in every linked app that builds from pushes to that branch. */
async function handlePush(request: Request, json: unknown, deps: WebhookDeps): Promise<Response> {
  const parsed = PushPayload.safeParse(json);
  if (!parsed.success) return reply({ error: "unexpected push payload" }, 400);
  const decision = acceptPush(parsed.data);
  if (!decision.accepted) return reply({ ok: true, ignored: decision.reason, results: [] });
  const push = decision.push;

  const targets = buildLinks(push.repo).filter((link) => linkBuildsPush(link, push));
  if (targets.length === 0) return reply({ ok: true, ignored: "no app builds from this push", results: [] });

  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return reply({ error: "missing or invalid X-GitHub-Delivery header" }, 400);

  const settled = await Promise.allSettled(targets.map((link) => buildTo(link, push, deliveryId, deps)));
  const results: DeliveryResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled" ? outcome.value : { server: targets[i]!.serverId, app: targets[i]!.app, outcome: "failed", detail: "unexpected error handling this app" },
  );
  auditDelivery(request, `${push.repo}@${push.sha.slice(0, 7)} (push to ${push.branch}, build): ${results.map((r) => `${r.server}/${r.app} ${r.outcome}`).join(", ")}`);
  return reply({ results });
}

/** An opened, reopened or updated pull request of the repository itself: builds and deploys its preview in every linked app that builds previews. */
async function handlePullBuild(request: Request, payload: PullRequestPayload, deps: WebhookDeps): Promise<Response> {
  const decision = acceptPullBuild(payload);
  if (!decision.accepted) return reply({ ok: true, ignored: decision.reason, results: [] });
  const pull = decision.pull;

  const targets = buildLinks(pull.repo).filter((link) => linkBuildsPull(link, pull));
  if (targets.length === 0) return reply({ ok: true, ignored: "no app builds previews from this pull request", results: [] });

  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return reply({ error: "missing or invalid X-GitHub-Delivery header" }, 400);

  const settled = await Promise.allSettled(targets.map((link) => buildPreviewTo(link, pull, deliveryId, deps)));
  const results: DeliveryResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { server: targets[i]!.serverId, app: previewName(targets[i]!.app, pull.number), outcome: "failed", detail: "unexpected error handling this preview" },
  );
  auditDelivery(request, `${pull.repo}#${pull.number}@${pull.sha.slice(0, 7)} (preview build): ${results.map((r) => `${r.server}/${r.app} ${r.outcome}`).join(", ")}`);
  return reply({ results });
}

/** A pull request event: closing it, merged or not, removes its preview from every app that has previews for the repository. Other actions are not used. */
async function handlePullRequest(request: Request, json: unknown, deps: WebhookDeps): Promise<Response> {
  const parsed = PullRequestPayload.safeParse(json);
  if (!parsed.success) return reply({ error: "unexpected pull_request payload" }, 400);
  const { action, repository, pull_request: pull } = parsed.data;
  if (action !== "closed") return handlePullBuild(request, parsed.data, deps);
  if (!validPullRequest(pull.number)) return reply({ ok: true, ignored: "the pull request number is out of range", results: [] });

  const targets = previewLinks(repository.full_name);
  if (targets.length === 0) return reply({ ok: true, ignored: "no app has previews for this repository", results: [] });

  const settled = await Promise.allSettled(targets.map((link) => removePreviewFrom(link, pull.number, deps)));
  const results: RemovalResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { server: targets[i]!.serverId, app: previewName(targets[i]!.app, pull.number), outcome: "failed", detail: "unexpected error handling this preview" },
  );
  auditDelivery(request, `${repository.full_name}#${pull.number} closed: ${results.map((r) => `${r.server}/${r.app} ${r.outcome}`).join(", ")}`);
  return reply({ results });
}

/**
 * The GitHub webhook. The signature is checked on the raw bytes before anything is parsed or read from the
 * database; then a successful run of the configured workflow deploys, in every linked app, the image tagged with its
 * commit, and for a pull request's run the preview of that pull request; a closed pull request removes its preview.
 * Answers within the time of the agents' replies: it never waits for a deployment to finish.
 */
export async function handleGithubWebhook(request: Request, deps: WebhookDeps = defaultDeps): Promise<Response> {
  let secret: string | null;
  try {
    secret = webhookSecret();
  } catch (err) {
    // A stored secret that cannot be decrypted (key changed, row damaged): say so instead of an anonymous 500.
    console.error("webhook: the secret cannot be read:", err);
    return reply({ error: "the webhook secret cannot be read; generate a new one in Integrations" }, 500);
  }
  if (secret === null) return reply({ error: "not found" }, 404);
  if (!isJson(request)) return reply({ error: "Set the webhook's content type to application/json in its GitHub settings." }, 415);

  const body = await readBody(request);
  if (body === null) return reply({ error: "payload too large" }, 413);
  if (!verifySignature(secret, body, request.headers.get("x-hub-signature-256"))) return reply({ error: "unauthorized" }, 401);

  const event = request.headers.get("x-github-event");
  if (event === "ping") return reply({ ok: true });
  if (event !== "workflow_run" && event !== "pull_request" && event !== "push") return reply({ ok: true, ignored: "event not used", results: [] });

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return reply({ error: "the body is not valid JSON" }, 400);
  }
  if (event === "pull_request") return handlePullRequest(request, json, deps);
  if (event === "push") return handlePush(request, json, deps);

  const parsed = WorkflowRunPayload.safeParse(json);
  if (!parsed.success) return reply({ error: "unexpected workflow_run payload" }, 400);
  // Runs of pull requests have a path of their own: the production one refuses them (see acceptRun).
  if (parsed.data.workflow_run.event === "pull_request") return handlePreviewRun(request, parsed.data, deps);

  const decision = acceptRun(parsed.data);
  if (!decision.accepted) return reply({ ok: true, ignored: decision.reason, results: [] });
  const run = decision.run;

  const targets = autoDeployLinks(run.repo).filter((link) => linkMatchesRun(link, run));
  if (targets.length === 0) return reply({ ok: true, ignored: "no app deploys automatically from this run", results: [] });

  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return reply({ error: "missing or invalid X-GitHub-Delivery header" }, 400);

  // In parallel, so the slowest agent (not the sum of them) sets the answer time; the order of the results is the targets'.
  const settled = await Promise.allSettled(targets.map((link) => deployTo(link, run, deliveryId, deps)));
  const results: DeliveryResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled" ? outcome.value : { server: targets[i]!.serverId, app: targets[i]!.app, outcome: "failed", detail: "unexpected error handling this app" },
  );

  auditDelivery(request, `${run.repo}@${run.sha.slice(0, 7)} (${run.workflow}): ${results.map((r) => `${r.server}/${r.app} ${r.outcome}`).join(", ")}`);
  return reply({ results });
}
