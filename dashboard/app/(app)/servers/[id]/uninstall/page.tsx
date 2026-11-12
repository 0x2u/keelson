import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadServer } from "@/lib/data";
import { PageHeader } from "@/components/page-header";
import { RelayUninstall } from "@/components/servers/RelayCommands";
import { UninstallWizard } from "@/components/servers/UninstallWizard";
import { canRunApps } from "@/lib/machine-core";
import { serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Uninstall the agent", server.name);
}

export default async function UninstallAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  // A server that does not serve traffic has no agent to uninstall from here (it is removed on the computer).
  if (!canRunApps(server)) redirect(`/servers/${id}/settings`);
  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server, { label: "Settings", href: `/servers/${id}/settings` }, { label: "Uninstall the agent" })}
        title="Uninstall the agent"
        description="Removes the agent from the server. The containers it started keep running."
      />
      <div className="max-w-3xl">
        {server.transport === "relay" ? <RelayUninstall serverName={server.name} /> : <UninstallWizard serverId={id} serverName={server.name} host={new URL(server.url).hostname} />}
      </div>
    </>
  );
}
