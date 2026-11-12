import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import { actionIntent } from "@/lib/action-intent-core";
import { Suspense } from "react";
import type { Metadata } from "next";
import { agentFor } from "@/lib/agent";
import type { Port } from "@/lib/agent-types";
import { load, loadServer } from "@/lib/data";
import { LiveLogs } from "@/components/LiveLogs";
import { LiveStats } from "@/components/LiveStats";
import { StatsHistory } from "@/components/StatsHistory";
import { parseRange } from "@/lib/history-core";
import { CopyButton } from "@/components/copy-button";
import { ContainerControls } from "@/components/ContainerControls";
import { ImageRef } from "@/components/image-ref";
import { appOfContainer } from "@/lib/container-core";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Notice } from "@/components/states";
import { ContainerBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { entityCrumbs } from "@/lib/nav-core";
import { projectOfContainer } from "@/lib/owner";

export async function generateMetadata({ params }: { params: Promise<{ id: string; name: string }> }): Promise<Metadata> {
  const { id, name } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(name), server.name, "Container");
}

/** "8080 → 80/tcp" for a published port, "80/tcp" for one that is only exposed. Docker lists each mapping once per address family. */
function portLabels(ports: Port[]): string[] {
  const labels = ports.map((p) => (p.public_port ? `${p.public_port} → ${p.private_port}/${p.type}` : `${p.private_port}/${p.type} (not published)`));
  return [...new Set(labels)];
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm break-words">{children}</dd>
    </div>
  );
}

export default async function ContainerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id, name: rawName }, query] = await Promise.all([params, searchParams]);
  const { range: rawRange } = query;
  const range = parseRange(rawRange);
  const name = decodeURIComponent(rawName);
  const server = loadServer(id);
  const agent = agentFor(server);
  // Started with the container itself: the history is read while the page is built.
  const history = load(agent.statsHistory(name, range));
  // The list carries the labels the detail lacks: the app the container belongs to, which tells whether Keelson manages it.
  const [detail, all] = await Promise.all([load(agent.container(name)), load(agent.containers(true))]);
  const appName = appOfContainer(all.data, name);
  // Under its project (Projects > shop > Apps > web > container) when an app or database of one owns it, under its server otherwise.
  const owner = await projectOfContainer(server, { name, appLabel: appName });
  const crumbs = entityCrumbs(
    owner,
    appName !== undefined ? "apps" : "databases",
    server,
    ...(appName !== undefined ? [{ label: appName, href: `/servers/${id}/apps/${encodeURIComponent(appName)}` }] : owner === null ? [{ label: "Containers", href: `/servers/${id}/containers` }] : []),
    { label: name },
  );

  if (detail.error !== undefined) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={name} />
        <LoadError title="Could not load this container" back={{ href: `/servers/${id}`, label: `Back to ${server.name}` }}>
          {detail.error}. The container may have been removed, or the agent on {server.name} may be unreachable.
        </LoadError>
      </>
    );
  }

  const c = detail.data;
  const ports = portLabels(c.ports ?? []);

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={c.name}
        status={<ContainerBadge state={c.state.status} health={c.state.health} />}
        actions={<ContainerControls serverId={id} name={c.name} state={c.state} managed={appName !== undefined} canDeploy={server.canDeploy} initialAction={actionIntent(query).container} />}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ImageRef value={c.image} className="max-w-full" />
            <span className="flex items-center gap-1">
              <span className="font-mono text-xs" title={c.id}>
                {c.id.slice(0, 12)}
              </span>
              <CopyButton value={c.id} label="Copy container id" />
            </span>
          </span>
        }
      />

      <div className="space-y-6">
        {c.state.oom_killed && (
          <Notice tone="warning" title="Out of memory">
            The last run was killed for exceeding its memory limit. Raise the limit or reduce what the application keeps in memory.
          </Notice>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>The environment is never shown: the agent does not return it.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Created">
                <RelativeTime at={c.created} />
              </Fact>
              <Fact label="Started">{c.state.started_at ? <RelativeTime at={c.state.started_at} /> : "Never started"}</Fact>
              {!c.state.running && c.state.finished_at && (
                <Fact label="Stopped">
                  <RelativeTime at={c.state.finished_at} />
                </Fact>
              )}
              <Fact label="Restarts">
                <span className="tabular">{c.restart_count}</span>
              </Fact>
              {!c.state.running && (
                <Fact label="Exit code">
                  <span className="tabular">{c.state.exit_code}</span>
                </Fact>
              )}
              <Fact label="Health check">{c.state.health ?? "None configured"}</Fact>
              <Fact label="Terminal">{c.tty ? "Allocated (TTY)" : "None"}</Fact>
              <Fact label="Ports">
                {ports.length === 0 ? (
                  "None"
                ) : (
                  <ul className="space-y-0.5">
                    {ports.map((p) => (
                      <li key={p} className="font-mono text-xs">
                        {p}
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
            </dl>
          </CardContent>
        </Card>

        <Tabs defaultValue={rawRange === undefined ? "logs" : "stats"}>
          <TabsList>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="mt-4">
            <LiveLogs serverId={id} container={c.name} />
          </TabsContent>
          <TabsContent value="stats" className="mt-4 space-y-4">
            <LiveStats serverId={id} container={c.name} running={c.state.running} />
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <StatsHistory range={range} history={history} href={(r) => `/servers/${id}/containers/${encodeURIComponent(c.name)}?range=${r}`} />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
