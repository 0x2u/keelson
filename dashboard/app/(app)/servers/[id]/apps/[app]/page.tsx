import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ICONS } from "@/lib/icons";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { actionIntent } from "@/lib/action-intent-core";
import { hostsOf } from "@/lib/domain-status-core";
import { cloudflareSummary, getAppRepo, githubAppSummary } from "@/lib/integrations";
import { DomainsCard } from "@/components/domains/DomainsCard";
import { duration, shortRef } from "@/lib/format";
import { appVersion, neverDeployed } from "@/lib/app-version-core";
import { triggerLabel } from "@/lib/labels-core";
import { ImageRef } from "@/components/image-ref";
import { ContainerControls } from "@/components/ContainerControls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContainerBadge, DeploymentBadge } from "@/components/status";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { DeployControls } from "@/components/DeployControls";
import { PipelineLine } from "@/components/deployments/PipelineLine";
import { buildBlock } from "@/lib/build-now-core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigChangedBadge } from "@/components/config/ConfigChangedBadge";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { entityCrumbs } from "@/lib/nav-core";
import { hasHubPages, ownerOfApp } from "@/lib/owner-core";
import { projectOf } from "@/lib/projects-core";
import { appSourceHref, appVariablesHref } from "@/lib/redirects-core";
import { EnvChangedBadge } from "@/components/environment/EnvChangedBadge";
import { envPending } from "@/lib/env-core";
import { Suspense } from "react";
import { StatsHistory } from "@/components/StatsHistory";
import { AvailabilityCard, AvailabilitySkeleton } from "@/components/servers/AvailabilityCard";
import { parseRange } from "@/lib/history-core";
import { parseAvailabilityRange } from "@/lib/availability-core";
import { deploySummaryLine, summarizeDeployments } from "@/lib/deploy-summary-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string; app: string }> }): Promise<Metadata> {
  const { id, app } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(app), server.name, "App");
}

export default async function AppPage({ params, searchParams }: { params: Promise<{ id: string; app: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id, app: name }, query] = await Promise.all([params, searchParams]);
  const intent = actionIntent(query);
  // `?deploy=<tag>` opens the deploy dialog with that tag typed in (the link of "Saved. Not running yet").
  const initialRef = intent.deploy;
  // `?rollback=1` opens the rollback confirmation (the command palette's "Roll back"); it is the operator who confirms.
  const server = loadServer(id);
  const agent = agentFor(server);

  const [apps, history, proxy, config] = await Promise.all([load(agent.apps()), load(agent.deployments(name, 30)), load(agent.proxy()), load(agent.config())]);
  // Under its project when it has one (Projects > shop > Apps > web), under its server otherwise (a server that did not answer).
  const owner = apps.data ? ownerOfApp(apps.data, name) : null;
  const breadcrumbs = entityCrumbs(owner, "apps", server, { label: name });
  if (apps.error !== undefined) {
    return (
      <>
        <PageHeader title={name} breadcrumbs={breadcrumbs} />
        <LoadError title={`Could not load ${server.name}`} back={{ href: `/servers/${id}`, label: `Back to ${server.name}` }}>
          {apps.error}
        </LoadError>
      </>
    );
  }
  const app = apps.data?.find((a) => a.name === name);
  if (!app) notFound();

  const running = history.data?.some((d) => d.status === "running") ?? false;
  const link = getAppRepo(id, name);
  // It builds where it runs (a build: block) or on another server that the dashboard sends the image from (the app's build server).
  const builds = config.data?.model.apps?.find((a) => a.name === name)?.build !== undefined || link?.buildOn != null;
  const container = app.container;
  const last = app.last_deployment;
  const version = appVersion(app, history.data ?? null);
  const envChange = envPending(app, history.data ?? null);
  // The resource charts and the availability card each have a range in the URL; a link for one keeps the other.
  const range = parseRange(query.range);
  const availRange = parseAvailabilityRange(query.avail);
  const pageHref = (r: string, a: string) => {
    const q = new URLSearchParams();
    if (r !== "1h") q.set("range", r);
    if (a !== "24h") q.set("avail", a);
    const qs = q.toString();
    return `/servers/${id}/apps/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`;
  };
  // The history of an app is recorded under its containers (the newest one names the series); without a container there is none to read.
  const stats = container ? load(agent.statsHistory(container.name, range)) : null;
  const availability = load(agent.availability(name, availRange));

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={app.name}
        status={
          <>
            {container ? <ContainerBadge state={container.state.status} health={container.state.health} /> : <Badge variant="muted">Not deployed</Badge>}
            <ConfigChangedBadge serverId={id} app={name} />
            {envChange && <EnvChangedBadge serverId={id} app={name} href={hasHubPages(app) ? appVariablesHref(projectOf(app), id, name) : undefined} />}
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              on{" "}
              <Link href={`/servers/${id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                {server.name}
              </Link>
            </span>
            <span className="font-mono text-xs break-all">{app.image}</span>
          </span>
        }
        actions={
          <>
            <ConfigActionLink href={`/servers/${id}/config/apps/${app.name}`} enabled={server.canDeploy}>
              <ICONS.configuration />
              Edit configuration
            </ConfigActionLink>
            <Button asChild variant="outline">
              <Link href={hasHubPages(app) ? appSourceHref(projectOf(app), id, app.name) : `/servers/${id}/apps/${app.name}/source`}>
                <ICONS.source />
                Source
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={hasHubPages(app) ? appVariablesHref(projectOf(app), id, app.name) : `/servers/${id}/apps/${encodeURIComponent(app.name)}/environment`}>
                <ICONS.variables />
                Variables
              </Link>
            </Button>
            {container && <ContainerControls serverId={id} name={container.name} state={container.state} managed canDeploy={server.canDeploy} deploying={running} />}
            <DeployControls
              serverId={id}
              app={app.name}
              canDeploy={server.canDeploy}
              running={running}
              current={container?.image ?? ""}
              history={history.data ?? null}
              neverDeployed={neverDeployed(app, history.data ?? null)}
              source={
                builds
                  ? {
                      repo: link?.repo ?? "",
                      branch: link?.branch ?? "",
                      blocked: buildBlock({ canDeploy: server.canDeploy, githubAppConfigured: githubAppSummary() !== null, linked: link !== null, deploying: running }),
                    }
                  : null
              }
              initialRef={initialRef}
              initialRollback={intent.rollback}
            />
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>{version.kind === "last-known" ? `Last known version (${version.stopped ? "stopped" : "not running"})` : "Serving version"}</CardDescription>
              <CardTitle className="min-w-0 text-base">
                {version.kind === "never" ? <span className="text-muted-foreground">Nothing running</span> : <ImageRef value={version.ref} serving={version.kind === "serving"} />}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-muted-foreground">
              {version.kind === "last-known" && (
                <p>
                  {version.stopped ? "The container is stopped." : "Nothing serves now."}{" "}
                  {version.at && (
                    <>
                      It last ran <RelativeTime at={version.at} />.{" "}
                    </>
                  )}
                  {version.stopped ? "Start it or deploy again to serve." : "Deploy it again to serve."}
                </p>
              )}
              {version.kind === "never" && <p>Deploy a version to start this app.</p>}
              {container && (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/servers/${id}/containers/${encodeURIComponent(container.name)}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                    Container {container.name}
                  </Link>
                  <Link href={`/servers/${id}/containers/${encodeURIComponent(container.name)}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                    Logs
                  </Link>
                </span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardDescription>Container health</CardDescription>
              <CardTitle>{container ? <ContainerBadge state={container.state.status} health={container.state.health} /> : <Badge variant="muted">Not deployed</Badge>}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {container ? (
                <>
                  {container.state.started_at && container.state.running ? (
                    <>
                      Up since <RelativeTime at={container.state.started_at} />
                    </>
                  ) : (
                    <>Exit code {container.state.exit_code}</>
                  )}
                  {container.restart_count > 0 && <> · {container.restart_count} restarts</>}
                  {container.state.oom_killed && <> · killed for memory</>}
                </>
              ) : (
                "No container exists for this app."
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardDescription>Last deployment</CardDescription>
              <CardTitle>{last ? <DeploymentBadge status={last.status} trigger={last.trigger} image={last.ref} /> : <Badge variant="muted">None yet</Badge>}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {last ? (
                <>
                  <p>
                    <RelativeTime at={last.started_at} /> ·{" "}
                    <Link href={`/servers/${id}/deployments/${last.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      View log
                    </Link>
                  </p>
                  <PipelineLine deployment={last} />
                </>
              ) : (
                "This app has never been deployed from here."
              )}
            </CardContent>
          </Card>
        </div>

        <Suspense fallback={<AvailabilitySkeleton />}>
          <AvailabilityCard href={(r) => pageHref(range, r)} range={availRange} availability={availability} />
        </Suspense>

        {stats && (
          <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
            <StatsHistory title="Resource history" range={range} history={stats} href={(r) => pageHref(r, availRange)} />
          </Suspense>
        )}

        <DomainsCard serverId={id} hosts={hostsOf(proxy.data ?? null, app.name)} cloudflare={cloudflareSummary() !== null} />

        <Card>
          <CardHeader>
            <CardTitle>Deployment history</CardTitle>
            <CardDescription>The 30 most recent deployments of this app.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {history.error !== undefined ? (
              <div className="px-6">
                <Notice title="Could not load the deployment history">{history.error}</Notice>
              </div>
            ) : history.data.length === 0 ? (
              <EmptyState icon={ICONS.deploy} title="No deployment yet">
                Use Deploy to roll out the first version of {app.name}.
              </EmptyState>
            ) : (
              <>
                <p className="px-6 pb-3 text-sm text-muted-foreground tabular">{deploySummaryLine(summarizeDeployments(history.data))}</p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Image</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="hidden md:table-cell">Trigger</TableHead>
                        <TableHead className="hidden sm:table-cell">Duration</TableHead>
                        <TableHead>When</TableHead>
                        <TableHead className="hidden lg:table-cell">Error</TableHead>
                        <TableHead className="pr-6 text-right">
                          <span className="sr-only">Open</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.data.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="pl-6">
                            <ImageRef value={d.ref} className="max-w-64" />
                          </TableCell>
                          <TableCell>
                            <DeploymentBadge status={d.status} trigger={d.trigger} image={d.ref} />
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">{triggerLabel(d.trigger)}</TableCell>
                          <TableCell className="tabular hidden text-muted-foreground sm:table-cell">{duration(d.started_at, d.finished_at)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            <RelativeTime at={d.started_at} />
                          </TableCell>
                          <TableCell className="hidden max-w-xs lg:table-cell">
                            {d.error ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span tabIndex={0} className="block truncate rounded-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
                                    {d.error}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-md break-words">{d.error}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-muted-foreground">None</span>
                            )}
                          </TableCell>
                          <TableCell className="pr-6 text-right">
                            <Link
                              href={`/servers/${id}/deployments/${d.id}`}
                              className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Log<span className="sr-only"> of deployment {shortRef(d.ref)}</span>
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
