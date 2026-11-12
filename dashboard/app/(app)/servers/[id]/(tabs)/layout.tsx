import Link from "next/link";
import { EllipsisIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { Suspense, type ReactNode } from "react";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { ServerTabs } from "@/components/servers/ServerTabs";
import { ServerTabsBar } from "@/components/servers/ServerTabsBar";
import { ServerStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { agentUpdate, offersUpdate } from "@/lib/agent-binaries-core";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { loadServer } from "@/lib/data";
import { canRunApps } from "@/lib/machine-core";
import { serverActivityHref } from "@/lib/redirects-core";
import { baseTabs, serverCrumbs } from "@/lib/nav-core";
import { attentionItems, summarize } from "@/lib/attention-core";
import { serverInfo, serverSnapshot } from "@/lib/server-data";

async function ServerStatus({ serverId, machine }: { serverId: string; machine: boolean }) {
  const snapshot = await serverSnapshot(serverId);
  const attention = summarize(attentionItems([snapshot]));
  const status = <ServerStatusBadge reachable={snapshot.reachable} machine={machine} attention={attention} />;
  if (machine) {
    return (
      <>
        {status}
        <Badge variant="info">Does not serve traffic</Badge>
      </>
    );
  }
  if (!snapshot.reachable) return status;
  const info = await serverInfo(serverId);
  return (
    <>
      {status}
      {info.error === undefined && <Badge variant={info.data.read_only ? "muted" : "info"}>{info.data.read_only ? "Read-only" : "Deploy enabled"}</Badge>}
    </>
  );
}

async function AgentVersion({ serverId, machine }: { serverId: string; machine: boolean }) {
  const result = await serverInfo(serverId);
  if (result.error !== undefined) return null;
  // A machine that connects out is updated on the machine, not over SSH: no link to the update page.
  const state = machine ? "unknown" : agentUpdate(result.data.version, bundledAgentVersion());
  return (
    <span>
      {" "}
      · agent {result.data.version}
      {state === "newer" && " · Newer than this dashboard"}
      {offersUpdate(state) && (
        <>
          {" · "}
          <Link href={`/servers/${serverId}/update`} className="font-sans font-medium text-info underline-offset-4 hover:underline">
            Update available
          </Link>
        </>
      )}
    </span>
  );
}

/**
 * The frame of a server's tabs (Overview, Containers, Proxy): who it is, whether it answers, the pages
 * about the server itself, and the tab bar. The header paints at once; the agent's answers fill in as they arrive.
 */
export default async function ServerTabsLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  const machine = !canRunApps(server);
  const generatedAt = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request

  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server)}
        title={server.name}
        status={
          <Suspense fallback={<Skeleton className="h-5 w-28" />}>
            <ServerStatus serverId={id} machine={machine} />
          </Suspense>
        }
        description={
          <span className="font-mono text-xs">
            {server.transport === "relay" ? "Connects to Keelson" : server.url}
            <Suspense fallback={null}>
              <AgentVersion serverId={id} machine={machine} />
            </Suspense>
          </span>
        }
        actions={
          <>
            <LiveRefresh generatedAt={generatedAt} className="mr-1" />
            <div className="hidden items-center gap-2 sm:flex">
              <Button asChild variant="ghost">
                <Link href={`/servers/${id}/settings`}>
                  <ICONS.settings />
                  Settings
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/servers/${id}/config`}>
                  <ICONS.configuration />
                  Configuration
                </Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href={serverActivityHref(id)}>
                  <ICONS.activity />
                  Activity
                </Link>
              </Button>
            </div>
            <div className="flex items-center gap-2 sm:hidden">
              <Button asChild variant="outline">
                <Link href={`/servers/${id}/config`}>
                  <ICONS.configuration />
                  Configuration
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More server pages">
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={`/servers/${id}/settings`}>
                      <ICONS.settings />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={serverActivityHref(id)}>
                      <ICONS.activity />
                      Activity
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        }
      />
      <Suspense fallback={<ServerTabs serverId={id} tabs={baseTabs(id, machine)} />}>
        <ServerTabsBar serverId={id} machine={machine} />
      </Suspense>
      {children}
    </>
  );
}
