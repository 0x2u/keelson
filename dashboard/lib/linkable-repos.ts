import "server-only";
import type { PickableRepo } from "@/components/new-project/RepositoryStep";
import { githubRepos } from "@/lib/github";
import { listInstalledRepos } from "@/lib/github-app";
import { githubAppSummary, githubConnection } from "@/lib/integrations";

/**
 * The repositories an app can be linked to: those the GitHub App is installed on (with their default branch and whether they
 * are private), then those only a connected token can see. Whatever cannot be listed is left out: the dialog then offers to type
 * the name.
 */
export async function linkableRepos(): Promise<PickableRepo[]> {
  const out = new Map<string, PickableRepo>();
  if (githubAppSummary() !== null) {
    try {
      for (const r of await listInstalledRepos()) out.set(r.fullName.toLowerCase(), { fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private });
    } catch {
      // the App's list is not available now: the token's, if any, still is
    }
  }
  const connection = githubConnection();
  if (connection) {
    try {
      for (const name of await githubRepos(connection.token)) if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { fullName: name, defaultBranch: "", private: false });
    } catch {
      // the token's list is not available now
    }
  }
  return [...out.values()];
}
