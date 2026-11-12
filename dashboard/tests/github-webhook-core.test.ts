import { describe, expect, it } from "vitest";
import { statusDescription } from "@/lib/github-core";
import {
  PullRequestPayload,
  WorkflowRunPayload,
  acceptPreviewRun,
  acceptRun,
  decideDeploy,
  decidePreviewDeploy,
  linkMatchesRun,
  previewName,
  previewPullRequests,
  signBody,
  validPullRequest,
  verifySignature,
  webhookUrl,
  type AcceptedPreviewRun,
  type AcceptedRun,
} from "@/lib/github-webhook-core";

const SECRET = "s".repeat(64);
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

describe("signature", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });

  it("accepts the HMAC-SHA256 of the raw bytes", () => {
    expect(verifySignature(SECRET, body, signBody(SECRET, body))).toBe(true);
    expect(verifySignature(SECRET, Buffer.from(body), signBody(SECRET, body))).toBe(true);
    // Matches a signature computed independently (openssl dgst -sha256 -hmac), not only our own function.
    expect(signBody("It's a Secret to Everybody", "Hello, World!")).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });

  it("refuses a wrong secret, a changed body, and a header without the prefix", () => {
    expect(verifySignature("x".repeat(64), body, signBody(SECRET, body))).toBe(false);
    expect(verifySignature(SECRET, body + " ", signBody(SECRET, body))).toBe(false);
    expect(verifySignature(SECRET, body, signBody(SECRET, body).slice("sha256=".length))).toBe(false);
    expect(verifySignature(SECRET, body, signBody(SECRET, body).replace("sha256=", "sha1="))).toBe(false);
  });

  it("refuses a missing, empty, short, long or non-hex header", () => {
    const good = signBody(SECRET, body);
    for (const bad of [null, undefined, "", "sha256=", good.slice(0, -2), good + "00", "sha256=" + "z".repeat(64)]) {
      expect(verifySignature(SECRET, body, bad), String(bad)).toBe(false);
    }
  });
});

function payload(over: { action?: string; run?: Record<string, unknown>; repo?: string } = {}): WorkflowRunPayload {
  return WorkflowRunPayload.parse({
    action: over.action ?? "completed",
    repository: { full_name: over.repo ?? "Acme/Shop" },
    workflow_run: {
      id: 4242,
      run_attempt: 2,
      name: "Build and push",
      conclusion: "success",
      event: "push",
      head_sha: SHA,
      head_branch: "main",
      head_repository: { full_name: "Acme/Shop" },
      ...over.run,
    },
  });
}

describe("which runs may deploy", () => {
  it("accepts a successful completed push run of the repository itself", () => {
    expect(acceptRun(payload())).toEqual({ accepted: true, run: { repo: "Acme/Shop", branch: "main", sha: SHA, workflow: "Build and push", runKey: "acme/shop#4242#2" } });
    expect(acceptRun(payload({ run: { event: "workflow_dispatch" } })).accepted).toBe(true);
  });

  it("refuses runs that are not finished successes", () => {
    expect(acceptRun(payload({ action: "requested" })).accepted).toBe(false);
    expect(acceptRun(payload({ action: "in_progress" })).accepted).toBe(false);
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
      expect(acceptRun(payload({ run: { conclusion } })).accepted, String(conclusion)).toBe(false);
    }
  });

  it("refuses pull request runs and fork builds", () => {
    expect(acceptRun(payload({ run: { event: "pull_request" } }))).toMatchObject({ accepted: false });
    expect(acceptRun(payload({ run: { event: "pull_request_target" } }))).toMatchObject({ accepted: false });
    expect(acceptRun(payload({ run: { head_repository: { full_name: "mallory/Shop" } } }))).toMatchObject({ accepted: false, reason: "the run comes from a fork" });
    expect(acceptRun(payload({ run: { head_repository: null } })).accepted).toBe(false);
  });

  it("compares the head repository with the repository without regard to case", () => {
    expect(acceptRun(payload({ repo: "acme/shop" })).accepted).toBe(true);
  });

  it("refuses a head SHA that is not 40 lowercase hex digits", () => {
    for (const head_sha of ["abc1234", "A".repeat(40), "g".repeat(40), SHA + "0", ""]) {
      expect(acceptRun(payload({ run: { head_sha } })).accepted, head_sha).toBe(false);
    }
  });

  it("needs a branch and a workflow name", () => {
    expect(acceptRun(payload({ run: { head_branch: null } })).accepted).toBe(false);
    expect(acceptRun(payload({ run: { name: null } })).accepted).toBe(false);
  });

  it("takes the run id and attempt from the payload for the run key, the attempt defaulting to 1", () => {
    const noAttempt = acceptRun(payload({ run: { run_attempt: undefined } }));
    expect(noAttempt.accepted && noAttempt.run.runKey).toBe("acme/shop#4242#1");
    expect(WorkflowRunPayload.safeParse({ ...payload(), workflow_run: { ...payload().workflow_run, id: undefined } }).success).toBe(false);
  });

  it("rejects a payload that is not shaped like a workflow_run", () => {
    expect(WorkflowRunPayload.safeParse({}).success).toBe(false);
    expect(WorkflowRunPayload.safeParse({ action: "completed", repository: {}, workflow_run: {} }).success).toBe(false);
  });
});

describe("which links a run feeds", () => {
  const run: AcceptedRun = { repo: "Acme/Shop", branch: "main", sha: SHA, workflow: "Build and push", runKey: "acme/shop#4242#2" };
  const link = { repo: "acme/shop", branch: "main", autoDeployWorkflow: "Build and push" };

  it("matches the repository in any case, the branch and the workflow name", () => {
    expect(linkMatchesRun(link, run)).toBe(true);
  });

  it("refuses another branch, another workflow, another repository, and a link with automatic deploys off", () => {
    expect(linkMatchesRun({ ...link, branch: "staging" }, run)).toBe(false);
    expect(linkMatchesRun({ ...link, branch: "Main" }, run)).toBe(false);
    expect(linkMatchesRun({ ...link, autoDeployWorkflow: "Lint" }, run)).toBe(false);
    expect(linkMatchesRun({ ...link, repo: "acme/other" }, run)).toBe(false);
    expect(linkMatchesRun({ ...link, autoDeployWorkflow: null }, run)).toBe(false);
  });
});

describe("what a deployment may replace", () => {
  it("deploys a newer commit, and the first deployment of an app that serves nothing", () => {
    expect(decideDeploy({ sha: SHA, servingRef: `ghcr.io/acme/shop:${OLD}`, comparison: { aheadBy: 3, behindBy: 0 } })).toEqual({ deploy: true });
    expect(decideDeploy({ sha: SHA, servingRef: null, comparison: null })).toEqual({ deploy: true });
    expect(decideDeploy({ sha: SHA, servingRef: null, comparison: null, problem: "no_token" })).toEqual({ deploy: true });
  });

  it("skips, saying the order is unknown, when it cannot place the commit against what is serving", () => {
    const reason = (args: Parameters<typeof decideDeploy>[0]) => {
      const out = decideDeploy(args);
      expect(out.deploy).toBe(false);
      return out.deploy ? "" : out.reason;
    };
    expect(reason({ sha: SHA, servingRef: `x:${OLD}`, comparison: null, problem: "no_token" })).toMatch(/ordering unknown.*no GitHub token/);
    expect(reason({ sha: SHA, servingRef: `x:${OLD}`, comparison: null, problem: "failed" })).toMatch(/ordering unknown.*failed or timed out/);
    expect(reason({ sha: SHA, servingRef: "ghcr.io/acme/shop:v1", comparison: null })).toMatch(/ordering unknown.*not tagged with a commit/);
    expect(reason({ sha: SHA, servingRef: "ghcr.io/acme/shop@sha256:" + "0".repeat(64), comparison: null, problem: "no_token" })).toMatch(/ordering unknown/);
  });

  it("skips a diverged history (ahead and behind), which a force push produces", () => {
    const out = decideDeploy({ sha: SHA, servingRef: `x:${OLD}`, comparison: { aheadBy: 1, behindBy: 2 } });
    expect(out).toMatchObject({ deploy: false });
    expect(!out.deploy && out.reason).toContain("diverged");
  });

  it("skips what is already serving, in full or abbreviated form", () => {
    expect(decideDeploy({ sha: SHA, servingRef: `x:${SHA}`, comparison: null })).toEqual({ deploy: false, reason: "already serving" });
    expect(decideDeploy({ sha: SHA, servingRef: `x:${SHA.slice(0, 12)}`, comparison: null })).toMatchObject({ deploy: false });
  });

  it("skips a commit strictly behind the serving one", () => {
    expect(decideDeploy({ sha: OLD, servingRef: `x:${SHA}`, comparison: { aheadBy: 0, behindBy: 4 } })).toEqual({
      deploy: false,
      reason: "older than what is serving",
    });
  });
});

describe("the payload URL", () => {
  const base = { publicUrl: null, host: "dash.local:3000", forwardedHost: null, forwardedProto: null, trustProxy: false, secure: false };

  it("prefers the configured public URL", () => {
    expect(webhookUrl({ ...base, publicUrl: new URL("https://keelson.example.com/ignored") })).toBe("https://keelson.example.com/api/webhooks/github");
  });

  it("uses the request's host, and the forwarded one only behind a trusted proxy", () => {
    expect(webhookUrl(base)).toBe("http://dash.local:3000/api/webhooks/github");
    const forwarded = { ...base, forwardedHost: "keelson.example.com", forwardedProto: "https" };
    expect(webhookUrl(forwarded)).toBe("http://dash.local:3000/api/webhooks/github");
    expect(webhookUrl({ ...forwarded, trustProxy: true })).toBe("https://keelson.example.com/api/webhooks/github");
  });

  it("says https for a secure-cookie dashboard on a real host, but plain http for a loopback host reached directly (curl fails on https there)", () => {
    const secure = { ...base, secure: true };
    expect(webhookUrl({ ...secure, host: "dash.local:3000" })).toBe("https://dash.local:3000/api/webhooks/github");
    for (const host of ["localhost:3100", "127.0.0.1:3000", "[::1]:3000", "localhost"]) {
      expect(webhookUrl({ ...secure, host }), host).toBe(`http://${host}/api/webhooks/github`);
    }
    // A look-alike is not loopback, and a trusted proxy that says https is believed even for a loopback host.
    expect(webhookUrl({ ...secure, host: "localhost.evil.example" })).toBe("https://localhost.evil.example/api/webhooks/github");
    expect(webhookUrl({ ...secure, host: "localhost:3000", trustProxy: true, forwardedProto: "https" })).toBe("https://localhost:3000/api/webhooks/github");
  });

  it("is null without a usable host", () => {
    expect(webhookUrl({ ...base, host: null })).toBeNull();
    expect(webhookUrl({ ...base, host: "evil.example/<script>" })).toBeNull();
  });
});

function prPayload(over: { action?: string; run?: Record<string, unknown>; repo?: string } = {}): WorkflowRunPayload {
  return payload({ ...over, run: { event: "pull_request", head_branch: "feature", pull_requests: [{ number: 12, base: { ref: "main" } }], ...over.run } });
}

describe("which pull request runs may create a preview", () => {
  it("accepts a successful completed pull_request run of the repository itself, with its pull requests and the base of each", () => {
    expect(acceptPreviewRun(prPayload())).toEqual({
      accepted: true,
      run: { repo: "Acme/Shop", headBranch: "feature", sha: SHA, workflow: "Build and push", runKey: "acme/shop#4242#2", pullRequests: [{ number: 12, base: "main" }] },
    });
  });

  it("refuses each way a run falls short, with a reason", () => {
    const refused = (decision: ReturnType<typeof acceptPreviewRun>) => (decision.accepted ? null : decision.reason);
    expect(refused(acceptPreviewRun(prPayload({ action: "requested" })))).toBe("the run has not completed");
    for (const conclusion of ["failure", "cancelled", "skipped", null]) {
      expect(refused(acceptPreviewRun(prPayload({ run: { conclusion } }))), String(conclusion)).toBe("the run did not succeed");
    }
    // Only pull_request: a push, a manual run, and pull_request_target (which has the base's secrets) never create one.
    for (const event of ["push", "workflow_dispatch", "pull_request_target", "schedule"]) {
      expect(refused(acceptPreviewRun(prPayload({ run: { event } }))), event).toBe("only pull_request runs create previews");
    }
    expect(refused(acceptPreviewRun(prPayload({ run: { head_repository: { full_name: "mallory/Shop" } } })))).toBe("the run comes from a fork");
    expect(refused(acceptPreviewRun(prPayload({ run: { head_repository: null } })))).toBe("the run comes from a fork");
    for (const head_sha of ["abc1234", "A".repeat(40), SHA + "0", ""]) expect(acceptPreviewRun(prPayload({ run: { head_sha } })).accepted, head_sha).toBe(false);
    expect(refused(acceptPreviewRun(prPayload({ run: { name: null } })))).toBe("the run has no workflow name");
    for (const pull_requests of [[], undefined, null, [{ number: 0, base: { ref: "main" } }], [{ number: 1_000_000, base: { ref: "main" } }], [{ number: -3 }]]) {
      expect(refused(acceptPreviewRun(prPayload({ run: { pull_requests } }))), JSON.stringify(pull_requests)).toBe("the run belongs to no pull request");
    }
  });

  it("keeps each valid pull request once and drops the invalid ones, a missing base becoming null", () => {
    const out = acceptPreviewRun(prPayload({ run: { pull_requests: [{ number: 7, base: { ref: "main" } }, { number: 7, base: { ref: "main" } }, { number: 0 }, { number: 8 }] } }));
    expect(out.accepted && out.run.pullRequests).toEqual([
      { number: 7, base: "main" },
      { number: 8, base: null },
    ]);
  });

  it("is refused by the production path whatever it is, and the production path stays as it was", () => {
    expect(acceptRun(prPayload())).toMatchObject({ accepted: false, reason: "pull request runs never deploy" });
  });
});

describe("which pull requests a link makes a preview for", () => {
  const run: AcceptedPreviewRun = {
    repo: "Acme/Shop",
    headBranch: "feature",
    sha: SHA,
    workflow: "Build and push",
    runKey: "acme/shop#4242#2",
    pullRequests: [
      { number: 12, base: "main" },
      { number: 13, base: "release" },
      { number: 14, base: null },
    ],
  };
  const link = { repo: "acme/shop", branch: "main", previewsWorkflow: "Build and push" };

  it("takes the pull requests that merge into the linked branch, for the repository in any case and the same workflow", () => {
    expect(previewPullRequests(link, run)).toEqual([12]);
    expect(previewPullRequests({ ...link, branch: "release" }, run)).toEqual([13]);
  });

  it("takes none when previews are off, or the workflow, the repository or the base branch differ", () => {
    expect(previewPullRequests({ ...link, previewsWorkflow: null }, run)).toEqual([]);
    expect(previewPullRequests({ ...link, previewsWorkflow: "Lint" }, run)).toEqual([]);
    expect(previewPullRequests({ ...link, repo: "acme/other" }, run)).toEqual([]);
    expect(previewPullRequests({ ...link, branch: "staging" }, run)).toEqual([]);
    expect(previewPullRequests({ ...link, branch: "Main" }, run)).toEqual([]);
  });
});

describe("what a preview may be redeployed over", () => {
  it("deploys the first time, a newer commit, a diverged one (a force push) and one that cannot be compared", () => {
    expect(decidePreviewDeploy({ sha: SHA, servingRef: null, comparison: null })).toEqual({ deploy: true });
    expect(decidePreviewDeploy({ sha: SHA, servingRef: `x:${OLD}`, comparison: { aheadBy: 2, behindBy: 0 } })).toEqual({ deploy: true });
    expect(decidePreviewDeploy({ sha: SHA, servingRef: `x:${OLD}`, comparison: { aheadBy: 2, behindBy: 1 } })).toEqual({ deploy: true });
    expect(decidePreviewDeploy({ sha: SHA, servingRef: `x:${OLD}`, comparison: null })).toEqual({ deploy: true });
    expect(decidePreviewDeploy({ sha: SHA, servingRef: "ghcr.io/acme/shop:v1", comparison: null })).toEqual({ deploy: true });
  });

  it("skips the commit that serves, and one proven older", () => {
    expect(decidePreviewDeploy({ sha: SHA, servingRef: `x:${SHA}`, comparison: null })).toEqual({ deploy: false, reason: "already serving" });
    expect(decidePreviewDeploy({ sha: OLD, servingRef: `x:${SHA}`, comparison: { aheadBy: 0, behindBy: 3 } })).toEqual({ deploy: false, reason: "older than what is serving" });
  });
});

describe("pull request events and names", () => {
  it("reads a pull_request delivery and refuses one without a number", () => {
    expect(PullRequestPayload.parse({ action: "closed", repository: { full_name: "a/b" }, pull_request: { number: 5, merged: true } }).pull_request.number).toBe(5);
    expect(PullRequestPayload.safeParse({ action: "closed", repository: { full_name: "a/b" } }).success).toBe(false);
  });

  it("names a preview as the agent does and bounds the pull request number", () => {
    expect(previewName("shop", 12)).toBe("shop-pr-12");
    expect([0, -1, 1.5, 1_000_000, NaN].map(validPullRequest)).toEqual([false, false, false, false, false]);
    expect([1, 12, 999_999].map(validPullRequest)).toEqual([true, true, true]);
  });

  it("keeps a status description to one line of at most 140 characters", () => {
    expect(statusDescription("Preview\n deploy\tfailed")).toBe("Preview deploy failed");
    const long = statusDescription("x".repeat(500));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
