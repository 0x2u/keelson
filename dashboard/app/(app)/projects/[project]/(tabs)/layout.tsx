import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { neverDeployed } from "@/lib/app-version-core";
import { buildBlock } from "@/lib/build-now-core";
import { githubAppSummary } from "@/lib/integrations";
import { hubPage, hubPlacements, loadProjectHub } from "@/lib/project-hub";
import { attentionTabs, hubSummary } from "@/lib/project-hub-core";
import { projectTabs } from "@/lib/nav-core";
import { activityHref } from "@/lib/redirects-core";
import { siteUrl } from "@/lib/project-view-core";
import { DeployControls } from "@/components/DeployControls";
import { LiveRefresh } from "@/components/LiveRefresh";
import { CantTell } from "@/components/fleet/Unreachable";
import { PageHeader } from "@/components/page-header";
import { ProjectActionsMenu } from "@/components/projects/ProjectActionsMenu";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The frame of a project's tabs (Overview, Apps, Jobs, Databases, Domains, Variables, Source, Configuration): who it
 * is, what can be done to its primary environment, and the tab bar with what each tab holds.
 */
export default async function ProjectTabsLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) {
    const { unreachable } = await hubPlacements();
    // The project may live on a server that did not answer: "not found" would be a guess.
    if (unreachable.length === 0) notFound();
    return (
      <>
        <PageHeader breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: name }]} title={name} />
        <Card>
          <CantTell servers={unreachable.map((s) => ({ id: s.id, name: s.name, reason: s.reason }))} what={`The project ${name}`} />
        </Card>
      </>
    );
  }

  const page = await hubPage(hub.project);
  const { primary } = page;
  const view = page.project;
  const { server, app } = primary.placement;
  const running = primary.history?.some((d) => d.status === "running") ?? app.last_deployment?.status === "running";
  const domain = view.primary.domain;
  const summary = hubSummary(hub.project, hub.members, hub.generatedAt);
  const tabs = projectTabs(
    name,
    { apps: summary.apps.count, jobs: summary.jobs.count, databases: summary.databases.count, domains: summary.domains.count },
    attentionTabs(summary, hub.unreachable.length),
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: hub.project.name }]}
        title={hub.project.name}
        description={
          view.repo !== null && (
            <a href={`https://github.com/${view.repo}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-mono text-xs underline-offset-4 hover:underline">
              <ICONS.source aria-hidden className="size-3.5" />
              {view.repo}
            </a>
          )
        }
        actions={
          <>
            <LiveRefresh generatedAt={hub.generatedAt} />
            {domain !== null && (
              <Button asChild variant="outline">
                <a href={siteUrl(domain)} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                  Visit
                </a>
              </Button>
            )}
            <DeployControls
              serverId={server.id}
              app={app.name}
              canDeploy={server.canDeploy}
              running={running}
              current={app.container?.image ?? ""}
              history={primary.history}
              neverDeployed={neverDeployed(app, primary.history)}
              source={
                primary.builds
                  ? {
                      repo: primary.link?.repo ?? "",
                      branch: primary.link?.branch ?? "",
                      blocked: buildBlock({ canDeploy: server.canDeploy, githubAppConfigured: githubAppSummary() !== null, linked: primary.link !== null, deploying: running }),
                    }
                  : null
              }
            />
            <Button asChild variant="ghost">
              <Link href={activityHref({ project: name })}>
                <ICONS.activity />
                Activity
              </Link>
            </Button>
            <ProjectActionsMenu project={name} />
          </>
        }
      />
      <ProjectTabs project={name} tabs={tabs} />
      {children}
    </>
  );
}
