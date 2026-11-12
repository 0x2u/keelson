import "server-only";
import { githubCommits } from "@/lib/github";
import { GithubAppError, installationToken } from "@/lib/github-app";
import { GithubError } from "@/lib/github";
import { startBuild } from "@/lib/github-webhook";
import { getAppRepo } from "@/lib/integrations";

export type BuildRequest = { ok: true; deploymentId: string; serverId: string; sha: string; repo: string } | { ok: false; error: string; /** The build was asked of the agents and refused (false: the request never got that far). */ asked: boolean };

/**
 * Has the app's agent build a commit of the repository the app is linked to, and deploy it (on another server when the app
 * is built elsewhere): the commit in `sha`, or the head of the linked branch. The one place a click on Deploy and an
 * API call both go through, after each has checked who is asking.
 */
export async function requestBuild(serverId: string, app: string, sha: string | null): Promise<BuildRequest> {
  const link = getAppRepo(serverId, app);
  if (!link) return { ok: false, error: "Link this app to its repository first (Source).", asked: false };
  let commit = sha ?? "";
  if (commit !== "" && !/^[0-9a-f]{40}$/.test(commit)) return { ok: false, error: "That is not a full commit SHA.", asked: false };
  if (commit === "") {
    try {
      commit = (await githubCommits(await installationToken(link.repo), link.repo, link.branch))[0]?.sha ?? "";
    } catch (err) {
      return { ok: false, error: err instanceof GithubError || err instanceof GithubAppError ? err.message : "Something went wrong. Try again.", asked: false };
    }
    if (commit === "") return { ok: false, error: `${link.repo} has no commit on ${link.branch}.`, asked: false };
  }
  const started = await startBuild({ serverId, app }, { repo: link.repo, branch: link.branch, sha: commit });
  return started.ok ? { ok: true, deploymentId: started.deploymentId, serverId: started.serverId, sha: commit, repo: link.repo } : { ok: false, error: started.error, asked: true };
}
