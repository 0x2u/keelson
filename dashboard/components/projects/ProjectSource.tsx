import Link from "next/link";
import { ExternalLinkIcon, GitCommitHorizontalIcon, PlugIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { unlinkRepoAction } from "@/app/github-actions";
import { RelativeTime } from "@/components/relative-time";
import { AutoDeployCard } from "@/components/repository/AutoDeployCard";
import { BuildCard } from "@/components/repository/BuildCard";
import { DeployCommitButton } from "@/components/repository/DeployCommitButton";
import { LinkRepoDialog } from "@/components/repository/LinkRepoDialog";
import { PreviewsCard } from "@/components/repository/PreviewsCard";
import { CommitsCard, RunsCard } from "@/components/repository/SourceHistory";
import { SourceSummary } from "@/components/repository/SourceSummary";
import { EmptyState, Notice } from "@/components/states";
import { CiBadge, StatusBadge } from "@/components/status";
import { COMMIT_DEPLOYMENTS } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AppSource } from "@/lib/app-source";
import { deployBlock, githubUrl, workflowNames } from "@/lib/app-source-core";
import { buildBlock } from "@/lib/build-now-core";
import { commitCi, commitDeployment } from "@/lib/github-core";
import { placementSlot } from "@/lib/project-variables-core";
import { sourceHref, type SourceChoice } from "@/lib/project-source-core";
import { FormCard, SegmentedNav } from "@/components/layout";

/**
 * The repository an app of the project is built from: what serves compared with the branch head, CI, where it is built,
 * and when it deploys by itself. The cards are the ones of the app's own Source page; read-only servers get them disabled.
 */
export function ProjectSource({ project, choices, chosen, source }: { project: string; choices: SourceChoice[]; chosen: SourceChoice; source: AppSource }) {
  const { placement } = chosen;
  const { server, app } = placement;
  const id = server.id;
  const name = app.name;
  const slot = placementSlot(placement);

  const switcher = choices.length > 1 && (
    <SegmentedNav
      label="App"
      items={choices.map((c, i) => {
        const s = placementSlot(c.placement);
        return {
          key: s,
          href: sourceHref(project, i === 0 ? undefined : s),
          current: s === slot,
          label: (
            <>
              {c.placement.app.name}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {c.environment} on {c.placement.server.name}
              </span>
            </>
          ),
        };
      })}
    />
  );

  if (source.kind === "missing") {
    return (
      <div className="space-y-4">
        {switcher}
        <Notice tone="warning" title={`${name} is no longer on ${server.name}`}>
          The server does not list this app any more. Reload the page to see what the project has now.
        </Notice>
      </div>
    );
  }

  const { context } = source;
  const { githubApp, secretSet, build, where } = context;
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
    const { kept, keptPreviews } = source;
    return (
      <div className="space-y-6">
        {switcher}
        {kept && (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{kept.repo}</span> on <span className="font-mono">{kept.branch}</span>, linked earlier.
          </p>
        )}
        {kept && <AutoDeployCard serverId={id} app={name} workflow={kept.autoDeployWorkflow} suggestions={[]} secretSet={secretSet} canDeploy={server.canDeploy} />}
        {kept && keptPreviews && (
          <PreviewsCard serverId={id} app={name} workflow={kept.previewsWorkflow} suggestions={[]} secretSet={secretSet} canDeploy={server.canDeploy} previews={keptPreviews} />
        )}
        {kept && buildCard(kept)}
        <EmptyState
          bordered
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
      </div>
    );
  }

  if (source.kind === "unlinked") {
    return (
      <div className="space-y-6">
        {switcher}
        <EmptyState bordered icon={ICONS.source} title="No repositories linked yet" action={<LinkRepoDialog serverId={id} app={name} repos={source.repos} />}>
          Link the repository the images of {name} are built from to see its commits and CI runs here, and to deploy it by itself.
        </EmptyState>
      </div>
    );
  }

  const { link, serving, servingSha, commits, runs, behind, repos, previews, deployments, deploying } = source;
  const latestRun = runs.data?.[0];
  const suggestions = workflowNames(runs.data ?? []);
  const servingCommit = commits.data?.find((c) => servingSha !== null && c.sha.startsWith(servingSha));
  const head = commits.data?.[0];
  const headState = head ? commitDeployment(head.sha, serving, deployments) : null;
  const headCi = head && runs.data ? commitCi(head.sha, runs.data) : null;
  const headUrl = head ? githubUrl(head.url) : null;

  return (
    <div className="space-y-6">
      {switcher}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <a href={`https://github.com/${link.repo}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-sm underline-offset-4 hover:underline">
            <ICONS.source aria-hidden className="size-4" />
            {link.repo}
            <ExternalLinkIcon className="size-3" />
            <span className="font-sans text-muted-foreground">on</span> {link.branch}
          </a>
          <div className="flex flex-wrap items-center gap-2">
            <LinkRepoDialog serverId={id} app={name} repos={repos} current={link} />
            <form action={unlinkRepoAction.bind(null, id, name)}>
              <Button type="submit" variant="ghost" disabled={!server.canDeploy}>
                Unlink
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>

      <SourceSummary branch={link.branch} serving={serving} servingSha={servingSha} servingCommit={servingCommit} behind={behind.data} latestRun={latestRun} />

      <FormCard title="Deploy from source" description={<>The latest commit on {link.branch}. The commits and workflow runs before it are listed below.</>}>
          {commits.error !== undefined ? (
            <Notice title="Could not load the commits">{commits.error}</Notice>
          ) : !head ? (
            <EmptyState compact icon={GitCommitHorizontalIcon} title="No commits yet">
              GitHub returned no commits for {link.branch}.
            </EmptyState>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3" data-testid="head-commit">
              <div className="min-w-0 space-y-1">
                <div className="truncate font-medium">{head.message}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {headUrl ? (
                    <a href={headUrl} target="_blank" rel="noreferrer noopener" className="font-mono underline-offset-4 hover:underline">
                      {head.sha.slice(0, 7)}
                    </a>
                  ) : (
                    <span className="font-mono">{head.sha.slice(0, 7)}</span>
                  )}
                  <span>{head.author}</span>
                  {head.date && <RelativeTime at={head.date} />}
                  {headCi ? <CiBadge state={headCi} /> : <span className="text-muted-foreground">No CI run</span>}
                  {headState ? <StatusBadge view={COMMIT_DEPLOYMENTS[headState]} /> : <span className="text-muted-foreground">Not deployed</span>}
                </div>
              </div>
              <DeployCommitButton
                serverId={id}
                app={name}
                sha={head.sha}
                message={head.message}
                blocked={
                  build || link.buildOn
                    ? buildBlock({ canDeploy: server.canDeploy, githubAppConfigured: githubApp !== null, linked: true, deploying, serving: headState === "serving" })
                    : deployBlock({ canDeploy: server.canDeploy, deploying, serving: headState === "serving", ci: headCi })
                }
                builds={build || link.buildOn ? { warning: where.buildWarning } : null}
              />
            </div>
          )}
      </FormCard>

      <AutoDeployCard serverId={id} app={name} workflow={link.autoDeployWorkflow} suggestions={suggestions} secretSet={secretSet} canDeploy={server.canDeploy} />
      <PreviewsCard serverId={id} app={name} workflow={link.previewsWorkflow} suggestions={suggestions} secretSet={secretSet} canDeploy={server.canDeploy} previews={previews} />
      {buildCard(link)}
      <CommitsCard serverId={id} app={name} source={source} build={Boolean(build)} canDeploy={server.canDeploy} />
      <RunsCard source={source} />
    </div>
  );
}
