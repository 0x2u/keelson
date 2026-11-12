import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HealthSkeleton } from "@/components/ServerSkeleton";
import { AppsSection, DeploymentsSection, MachineSection, ReadinessSection, ScheduledSection, StatusSection } from "@/components/servers/ServerOverview";
import { DockerDisk, ServerHealth } from "@/components/servers/ServerHealth";
import { HostHistory, HostHistorySkeleton } from "@/components/servers/HostHistory";
import { parseRange } from "@/lib/history-core";
import { loadServer } from "@/lib/data";
import { canRunApps } from "@/lib/machine-core";
import { legacyTabHref } from "@/lib/nav-core";
import { serverContainers, serverDisk, serverHostHistory, serverInfo, serverSystem } from "@/lib/server-data";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata(server.name, "Server");
}

/** The overview: is the server fine and, if not, what; then its apps, how many jobs and databases it has (links to their lists), its last deployments, its resources, how they changed over the last hours and, folded away, what Docker keeps on disk. */
export default async function ServerOverviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[]; range?: string | string[] }> }) {
  const [{ id }, { tab, range: rawRange }] = await Promise.all([params, searchParams]);
  // The tabs used to be `?tab=containers` on this page; they are routes now, and old links and bookmarks still arrive here.
  const moved = legacyTabHref(id, tab);
  if (moved !== null) redirect(moved);
  const server = loadServer(id);
  const machine = !canRunApps(server);
  const range = parseRange(rawRange);

  return (
    <div className="space-y-6">
      <Suspense fallback={<HealthSkeleton rows={1} />}>{machine ? <MachineSection serverId={id} /> : <StatusSection serverId={id} />}</Suspense>
      <Suspense fallback={<HealthSkeleton rows={4} />}>
        <AppsSection serverId={id} canDeploy={server.canDeploy} machine={machine} />
      </Suspense>
      {!machine && (
        <Suspense fallback={null}>
          <ScheduledSection serverId={id} />
        </Suspense>
      )}
      {!machine && (
        <Suspense fallback={<HealthSkeleton rows={2} />}>
          <ReadinessSection serverId={id} />
        </Suspense>
      )}
      <Suspense fallback={<HealthSkeleton rows={4} />}>
        <DeploymentsSection serverId={id} />
      </Suspense>
      <Suspense fallback={<HealthSkeleton />}>
        <ServerHealth serverId={id} info={serverInfo(id)} system={serverSystem(id)} containers={serverContainers(id)} />
      </Suspense>
      {!machine && (
        <Suspense fallback={<HostHistorySkeleton />}>
          <HostHistory serverId={id} range={range} history={serverHostHistory(id, range)} />
        </Suspense>
      )}
      <Suspense fallback={<HealthSkeleton rows={1} />}>
        <DockerDisk info={serverInfo(id)} disk={serverDisk(id)} />
      </Suspense>
    </div>
  );
}
