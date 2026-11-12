import type { Metadata } from "next";
import Link from "next/link";
import { GithubRequiredNotice } from "@/components/new-project/GithubRequiredNotice";
import { NewImageProjectWizard } from "@/components/new-project/NewImageProjectWizard";
import { NewProjectDoors } from "@/components/new-project/NewProjectDoors";
import { NewProjectWizard } from "@/components/new-project/NewProjectWizard";
import { PageHeader } from "@/components/page-header";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { GithubAppError, listInstalledRepos, type InstalledRepo } from "@/lib/github-app";
import { githubAppSummary } from "@/lib/integrations";
import { newProjectHref } from "@/lib/nav-core";
import { loadProjectServers } from "@/lib/new-project";

export const metadata: Metadata = { title: "New project" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const githubConnected = githubAppSummary() !== null;
  const server = one(query.server);
  // A repository in the address is the repository door; otherwise the door is chosen, and none shows the two.
  const door = one(query.door) === "image" ? "image" : one(query.door) === "repository" || one(query.repo) !== undefined ? "repository" : null;
  const header = (
    <PageHeader
      breadcrumbs={
        door === null
          ? [{ label: "Projects", href: "/projects" }, { label: "New project" }]
          : [{ label: "Projects", href: "/projects" }, { label: "New project", href: newProjectHref(server ? { server } : {}) }, { label: door === "image" ? "From an image" : "From a repository" }]
      }
      title="New project"
      description={
        door === "image"
          ? "Run a ready-made image: name it, choose its tag and where it runs. Nothing is written before the last step."
          : door === "repository"
            ? "Pick a repository and how it is built: Keelson builds it on your server and deploys it. Nothing is written before the last step."
            : "Where does the project come from? Nothing is written before the last step of either way."
      }
    />
  );

  if (door === "repository" && !githubConnected) {
    return (
      <>
        {header}
        <GithubRequiredNotice server={server} />
      </>
    );
  }
  if (door === null) {
    return (
      <>
        {header}
        <NewProjectDoors githubConnected={githubConnected} server={server} />
      </>
    );
  }

  const { servers, skipped } = await loadProjectServers();
  if (servers.length === 0) {
    return (
      <>
        {header}
        <Notice
          tone="warning"
          title="No server to deploy to"
          action={
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href="/servers">Open servers</Link>
            </Button>
          }
        >
          A project goes to an online server that is not read-only here and has a configuration to write to.
          {skipped.length > 0 && (
            <ul className="mt-2 list-disc pl-4">
              {skipped.map((s) => (
                <li key={s.id}>
                  {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      </>
    );
  }

  if (door === "image") {
    return (
      <>
        {header}
        <NewImageProjectWizard servers={servers} initialServer={server} initialImage={one(query.image)} />
      </>
    );
  }

  let repos: InstalledRepo[];
  try {
    repos = await listInstalledRepos();
  } catch (err) {
    return (
      <>
        {header}
        <Notice title="Could not list the repositories">{err instanceof GithubAppError ? err.message : "The repositories the GitHub App can reach could not be listed."}</Notice>
      </>
    );
  }
  return (
    <>
      {header}
      <NewProjectWizard repos={repos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private }))} servers={servers} initialRepo={one(query.repo)} initialServer={server} />
    </>
  );
}
