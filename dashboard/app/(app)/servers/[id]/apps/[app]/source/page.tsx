import { entityMetadata, routeName } from "@/lib/metadata";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { ExternalLinkIcon, PlugIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { unlinkRepoAction } from "@/app/github-actions";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { loadAppSource } from "@/lib/app-source";
import { workflowNames } from "@/lib/app-source-core";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { AutoDeployCard } from "@/components/repository/AutoDeployCard";
import { BuildCard } from "@/components/repository/BuildCard";
import { SourceSummary } from "@/components/repository/SourceSummary";
import { LinkRepoDialog } from "@/components/repository/LinkRepoDialog";
import { PreviewsCard } from "@/components/repository/PreviewsCard";
import { CommitsCard, RunsCard } from "@/components/repository/SourceHistory";
import { serverCrumbs } from "@/lib/nav-core";
import { hasHubPages } from "@/lib/owner-core";
import { projectOf } from "@/lib/projects-core";
import { appSourceHref } from "@/lib/redirects-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string; app: string }> }): Promise<Metadata> {
  const { id, app } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(app), "Source", server.name);
}

export default async function SourcePage({ params }: { params: Promise<{ id: string; app: string }> }) {
  const { id, app: name } = await params;
  const server = loadServer(id);
  // The Source of an app of a project is the project's Source tab; only a preview instance keeps this page.
  const app = (await load(agentFor(server).apps())).data?.find((a) => a.name === name);
  if (app && hasHubPages(app)) redirect(appSourceHref(projectOf(app), id, name));
  const breadcrumbs = serverCrumbs(server, { label: name, href: `/servers/${id}/apps/${name}` }, { label: "Source" });

  const source = await loadAppSource(server, name);
  if (source.kind === "missing") notFound();
  const { context } = source;
  const { githubApp, where, build, secretSet } = context;

  const addFromGithub =
    githubApp !== null && server.canDeploy ? (
      <Button asChild variant="outline" size="sm">
        <Link href={`/projects/new?server=${encodeURIComponent(id)}`}>
          <ICONS.add />
          New project
        </Link>
      </Button>
    ) : undefined;
  const buildCard = (link: { buildOnPush: boolean; buildPreviews: boolean; buildOn: string | null }) => (
    <BuildCard
      serverId={id}
      app={name}
      appConfigured={githubApp !== null}
      appSlug={githubApp?.slug ?? null}
      onPush={link.buildOnPush}
      previews={link.buildPreviews}
      secretSet={secretSet}
      canDeploy={server.canDeploy}
      build={build}
      buildOn={link.buildOn}
      where={where}
    />
  );
  if (source.kind === "no-github") {
    // A link made earlier keeps working without the token (the webhook does not need it): its automatic deploys
    // must stay visible and switchable here.
    const { kept, keptPreviews } = source;
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Source" description={kept ? `${kept.repo} on ${kept.branch}` : `Where ${name} is built from.`} actions={addFromGithub} />
        <div className="space-y-6">
          {kept && <AutoDeployCard serverId={id} app={name} workflow={kept.autoDeployWorkflow} suggestions={[]} secretSet={secretSet} canDeploy={server.canDeploy} />}
          {kept && keptPreviews && (
            <PreviewsCard serverId={id} app={name} workflow={kept.previewsWorkflow} suggestions={[]} secretSet={secretSet} canDeploy={server.canDeploy} previews={keptPreviews} />
          )}
          {kept && buildCard(kept)}
          <Card>
            <CardContent>
              <EmptyState
                icon={PlugIcon}
                title="Connect GitHub first"
                action={
                  <Button asChild>
                    <Link href="/settings/integrations">Open integrations</Link>
                  </Button>
                }
              >
                With a read-only token, Keelson shows this app&apos;s commits and CI runs beside its deployments
                {kept ? ", and can tell that a commit is older than the one serving before an automatic deploy" : ""}.
              </EmptyState>
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  if (source.kind === "unlinked") {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Source" description={`Where ${name} is built from.`} actions={addFromGithub} />
        <Card>
          <CardContent>
            <EmptyState icon={ICONS.source} title="No repository linked" action={<LinkRepoDialog serverId={id} app={name} repos={source.repos} />}>
              Link the repository this app&apos;s images are built from to see its commits and CI runs here.
            </EmptyState>
          </CardContent>
        </Card>
      </>
    );
  }

  const { link, serving, servingSha, commits, runs, behind, repos, previews } = source;
  const repoUrl = `https://github.com/${link.repo}`;
  const latestRun = runs.data?.[0];
  const suggestions = workflowNames(runs.data ?? []);
  const servingCommit = commits.data?.find((c) => servingSha !== null && c.sha.startsWith(servingSha));

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title="Source"
        description={
          <a href={repoUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline">
            {link.repo}
            <ExternalLinkIcon className="size-3" />
            <span className="font-sans text-muted-foreground">on</span> {link.branch}
          </a>
        }
        actions={
          <>
            <LinkRepoDialog serverId={id} app={name} repos={repos} current={link} />
            <form action={unlinkRepoAction.bind(null, id, name)}>
              <Button type="submit" variant="ghost">
                Unlink
              </Button>
            </form>
          </>
        }
      />

      <div className="space-y-6">
        <SourceSummary branch={link.branch} serving={serving} servingSha={servingSha} servingCommit={servingCommit} behind={behind.data} latestRun={latestRun} />

        <AutoDeployCard
          serverId={id}
          app={name}
          workflow={link.autoDeployWorkflow}
          suggestions={suggestions}
          secretSet={secretSet}
          canDeploy={server.canDeploy}
        />

        <PreviewsCard
          serverId={id}
          app={name}
          workflow={link.previewsWorkflow}
          suggestions={suggestions}
          secretSet={secretSet}
          canDeploy={server.canDeploy}
          previews={previews}
        />

        {buildCard(link)}

        <CommitsCard serverId={id} app={name} source={source} build={Boolean(build)} canDeploy={server.canDeploy} />

        <RunsCard source={source} />
      </div>
    </>
  );
}
