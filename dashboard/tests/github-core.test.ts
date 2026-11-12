import { describe, expect, it } from "vitest";
import {
  commitCi,
  commitDeployment,
  commitKey,
  commitOfRef,
  fullCommitOfRef,
  isBranchName,
  parseCommit,
  parseCommits,
  parseComparison,
  parsePullRequest,
  parseRepo,
  parseBranchNames,
  parseRepoNames,
  pickBranch,
  parseRuns,
  refIsCommit,
  runState,
  type WorkflowRun,
} from "@/lib/github-core";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("repository names", () => {
  it("accepts owner/name and a GitHub address, and rejects what could escape the API path", () => {
    expect(parseRepo("0x2u/keelson")).toBe("0x2u/keelson");
    expect(parseRepo("  https://github.com/0x2u/keelson.git ")).toBe("0x2u/keelson");
    expect(parseRepo("https://github.com/0x2u/keelson/")).toBe("0x2u/keelson");
    for (const bad of ["keelson", "a/b/c", "../x", "a/..", "a/b?x=1", "a/b#c", "-a/b", "https://evil.example/a/b", "a/b.git", ""]) {
      expect(parseRepo(bad), bad).toBeNull();
    }
  });

  it("accepts branch names with slashes and refuses ones that git or a URL would misread", () => {
    expect(isBranchName("main")).toBe(true);
    expect(isBranchName("release/1.2")).toBe(true);
    for (const bad of ["", "-x", "a..b", "a/", "a b", "a?b", "a.lock", "a%2Fb"]) {
      expect(isBranchName(bad), bad).toBe(false);
    }
  });
});

describe("matching a deployment to a commit", () => {
  it("reads the commit from a SHA tag only", () => {
    expect(commitOfRef(`ghcr.io/o/web:${SHA}`)).toBe(SHA);
    expect(commitOfRef("ghcr.io/o/web:abc1234")).toBe("abc1234");
    expect(commitOfRef("ghcr.io/o/web:v1.2.3")).toBeNull();
    expect(commitOfRef("ghcr.io/o/web:latest")).toBeNull();
    expect(commitOfRef("localhost:5000/web")).toBeNull();
    expect(commitOfRef(`ghcr.io/o/web@sha256:${"c".repeat(64)}`)).toBeNull();
  });

  it("reads a commit a lookup can use only from a full 40-hex tag", () => {
    expect(fullCommitOfRef(`ghcr.io/o/web:${SHA}`)).toBe(SHA);
    expect(fullCommitOfRef("ghcr.io/o/web:abc1234")).toBeNull();
    expect(fullCommitOfRef("ghcr.io/o/web:v1.2.3")).toBeNull();
    expect(fullCommitOfRef(`ghcr.io/o/web@sha256:${"c".repeat(64)}`)).toBeNull();
  });

  it("keys a commit by repository (any letter case) and full hash", () => {
    expect(commitKey("Acme/Shop", SHA)).toBe(commitKey("acme/shop", SHA));
    expect(commitKey("acme/shop", SHA)).not.toBe(commitKey("acme/shop", OTHER));
    expect(commitKey("acme/shop", SHA)).not.toBe(commitKey("acme/other", SHA));
  });

  it("matches an abbreviated tag to the full commit", () => {
    expect(refIsCommit("o/web:aaaaaaa", SHA)).toBe(true);
    expect(refIsCommit("o/web:bbbbbbb", SHA)).toBe(false);
  });

  it("says what happened to a commit on this app", () => {
    const ref = `o/web:${SHA}`;
    expect(commitDeployment(SHA, ref, [])).toBe("serving");
    expect(commitDeployment(SHA, `o/web:${OTHER}`, [{ ref, status: "running" }])).toBe("deploying");
    expect(commitDeployment(SHA, `o/web:${OTHER}`, [{ ref, status: "failed" }, { ref, status: "succeeded" }])).toBe("deployed");
    expect(commitDeployment(SHA, `o/web:${OTHER}`, [{ ref, status: "rolled_back" }])).toBe("failed");
    expect(commitDeployment(SHA, `o/web:${OTHER}`, [{ ref: `o/web:${OTHER}`, status: "succeeded" }])).toBeNull();
    expect(commitDeployment(SHA, null, [])).toBeNull();
  });
});

describe("reading GitHub's answers", () => {
  it("keeps the first line of the message and prefers the account name over the git author", () => {
    const commits = parseCommits([
      {
        sha: SHA,
        html_url: "https://github.com/o/r/commit/" + SHA,
        commit: { message: "feat: one\n\nlong body", author: { name: "Git Name", date: "2026-01-02T03:04:05Z" } },
        author: { login: "octo" },
      },
      { sha: OTHER, commit: { message: "fix", author: { name: "Only Git", date: "2026-01-01T00:00:00Z" } }, author: null },
    ]);
    expect(commits).toEqual([
      { sha: SHA, message: "feat: one", author: "octo", date: "2026-01-02T03:04:05Z", url: "https://github.com/o/r/commit/" + SHA },
      { sha: OTHER, message: "fix", author: "Only Git", date: "2026-01-01T00:00:00Z", url: "" },
    ]);
  });

  it("reads the single-commit answer as one entry, and nothing else as null", () => {
    expect(parseCommit({ sha: SHA, commit: { message: "feat: one\n\nbody", author: { name: "Git Name", date: "2026-01-02T03:04:05Z" } }, author: { login: "octo" } })).toMatchObject({ sha: SHA, message: "feat: one", author: "octo" });
    expect(parseCommit({ message: "Not Found" })).toBeNull();
    expect(parseCommit(null)).toBeNull();
  });

  it("drops entries that are not what was expected instead of failing the page", () => {
    expect(parseCommits([{ sha: "short", commit: { message: "x" } }, { nope: true }, null, 3])).toEqual([]);
    expect(parseCommits({ message: "Bad credentials" })).toEqual([]);
    expect(parseRuns({ workflow_runs: [{ id: 1, head_sha: "x" }, "no"] })).toEqual([]);
    expect(parseRuns({ message: "Not Found" })).toEqual([]);
    expect(parseComparison({ ahead_by: "2" })).toBeNull();
    expect(parsePullRequest({ message: "Not Found" })).toBeNull();
    expect(parsePullRequest({ state: "open", head: {} })).toBeNull();
    expect(parsePullRequest({ state: "closed", merged: true, head: { sha: "ABC" } })).toEqual({ open: false, merged: true, headSha: "abc" });
    expect(parsePullRequest({ state: "open", head: { sha: "a".repeat(40) } })).toEqual({ open: true, merged: false, headSha: "a".repeat(40) });
    expect(parseRepoNames([{ full_name: "o/r" }, { full_name: "../x" }, {}])).toEqual(["o/r"]);
  });

  it("turns a run's status and conclusion into one state", () => {
    expect(runState("completed", "success")).toBe("success");
    expect(runState("completed", "timed_out")).toBe("failure");
    expect(runState("completed", "cancelled")).toBe("cancelled");
    expect(runState("completed", "skipped")).toBe("other");
    expect(runState("in_progress", "")).toBe("running");
    expect(runState("queued", "")).toBe("queued");
    const runs = parseRuns({
      workflow_runs: [
        { id: 7, head_sha: SHA, name: "CI", run_number: 12, status: "completed", conclusion: "failure", head_branch: "main", event: "push", created_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/o/r/actions/runs/7" },
      ],
    });
    expect(runs[0]).toMatchObject({ id: 7, name: "CI", number: 12, state: "failure", branch: "main", sha: SHA, startedAt: "2026-01-01T00:00:00Z" });
    expect(parseComparison({ ahead_by: 3, behind_by: 0 })).toEqual({ aheadBy: 3, behindBy: 0 });
  });
});

describe("the CI state of a commit", () => {
  const run = (sha: string, state: WorkflowRun["state"]): WorkflowRun => ({ id: 1, name: "CI", number: 1, state, branch: "main", sha, event: "push", startedAt: "", url: "" });

  it("is the worst of its runs: one failure or one unfinished run means it did not pass", () => {
    expect(commitCi(SHA, [run(SHA, "success"), run(SHA, "success")])).toBe("success");
    expect(commitCi(SHA, [run(SHA, "success"), run(SHA, "failure")])).toBe("failure");
    expect(commitCi(SHA, [run(SHA, "success"), run(SHA, "running")])).toBe("running");
    expect(commitCi(SHA, [run(OTHER, "failure")])).toBeNull();
  });
});

describe("branches", () => {
  it("lists a repository's branch names in GitHub's order and drops what cannot be a branch", () => {
    expect(parseBranchNames([{ name: "main" }, { name: "release/1.0" }, { name: "../x" }, { name: "bad name" }, {}, "no"])).toEqual(["main", "release/1.0"]);
    expect(parseBranchNames({ message: "Not Found" })).toEqual([]);
  });

  it("starts from the default branch if the repository has it, else main, master, or the first", () => {
    expect(pickBranch(["dev", "trunk", "main"], "trunk")).toBe("trunk");
    expect(pickBranch(["dev", "main"], "gone")).toBe("main");
    expect(pickBranch(["dev", "master"])).toBe("master");
    expect(pickBranch(["dev", "feature"])).toBe("dev");
    expect(pickBranch([])).toBe("");
  });
});
