import { entityMetadata, routeName } from "@/lib/metadata";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronDownIcon } from "lucide-react";
import { PageSection } from "@/components/layout";
import { hubPage, loadProjectHub } from "@/lib/project-hub";
import { hubSummary } from "@/lib/project-hub-core";
import { projectTabs } from "@/lib/nav-core";
import { appSourceHref, appVariablesHref } from "@/lib/redirects-core";
import { planPromotion, promotionView, type Environment } from "@/lib/projects-core";
import { UnansweredNotice } from "@/components/fleet/Unreachable";
import { BuildsCard } from "@/components/projects/BuildsCard";
import { DeploymentFeed } from "@/components/projects/DeploymentFeed";
import { EnvironmentList } from "@/components/projects/EnvironmentList";
import { ProductionHero } from "@/components/projects/ProductionHero";
import { ProjectSummaryCards } from "@/components/projects/ProjectSummaryCards";
import { PromoteButton } from "@/components/projects/PromoteButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ICONS } from "@/lib/icons";
import { addEnvironmentHref } from "@/lib/project-actions-core";

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }): Promise<Metadata> {
  return entityMetadata(routeName((await params).project), "Overview");
}
export const dynamic = "force-dynamic";


export default async function ProjectOverviewPage({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project);
  const hub = await loadProjectHub(name);
  if (!hub) notFound();

  const { project } = hub;
  const page = await hubPage(project);
  const { context, feed, builds, primary } = page;
  const view = page.project;
  const envs = project.environments;
  const first = (e: Environment) => e.placements[0];
  const allPairs = envs.flatMap((from) => envs.filter((to) => to.name !== from.name).map((to) => ({ from, to })));
  // An environment with nothing running has nothing to promote: it only gets a line when no pair is left.
  const pairs = allPairs.some((p) => first(p.from).app.container) ? allPairs.filter((p) => first(p.from).app.container) : allPairs;
  const { server, app } = primary.placement;
  const hrefs = Object.fromEntries(projectTabs(name).map((t) => [t.id, t.href]));

  return (
    <div className="space-y-8">
      <UnansweredNotice servers={hub.unreachable} what="The project" />

      <ProductionHero env={view.primary} variablesHref={appVariablesHref(name, view.primary.servers[0].id, view.primary.app)} />

      <ProjectSummaryCards summary={hubSummary(project, hub.members, hub.generatedAt)} hrefs={hrefs} unanswered={hub.unreachable.length > 0} />

      <PageSection
        title={view.environments.length > 1 ? "Other environments" : "Environments"}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={addEnvironmentHref(name)}>
              <ICONS.add />
              Add environment
            </Link>
          </Button>
        }
      >
        {view.environments.length > 1 ? (
          <EnvironmentList environments={view.environments.slice(1)} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {project.name} has one environment, <span className="capitalize">{view.primary.name}</span>. Add another (staging, say) to try a version before it goes live.
          </p>
        )}
      </PageSection>

      <PageSection title="Deployments">
        <DeploymentFeed entries={feed} context={context} />
      </PageSection>

      {(builds !== null || primary.link !== null) && (
        <BuildsCard builds={builds} context={context} sourceHref={primary.link !== null ? appSourceHref(project.name, server.id, app.name) : null} />
      )}

      {pairs.length > 0 && (
        <Card className="gap-0 py-0">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-6 py-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="leading-none font-semibold">Promote</span>
                <span className="text-sm text-muted-foreground">Deploy what serves in one environment to another</span>
              </span>
              <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 px-6 pb-5">
              <p className="text-sm text-muted-foreground">Deploys the exact image that serves in one environment to another. What was tested is what ships.</p>
              <div className="flex flex-wrap gap-4">
                {pairs.map(({ from, to }) => {
                  const f = first(from);
                  const t = first(to);
                  const plan = planPromotion(f, t);
                  return (
                    <PromoteButton
                      key={`${from.name}-${to.name}`}
                      input={{ fromServer: f.server.id, fromApp: f.app.name, toServer: t.server.id, toApp: t.app.name, expectedDigest: f.app.digest }}
                      fromLabel={from.name}
                      toLabel={to.name}
                      toServer={t.server.name}
                      toApp={t.app.name}
                      view={promotionView(f, t)}
                      blocked={plan.ok ? null : plan.reason}
                    />
                  );
                })}
              </div>
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}
