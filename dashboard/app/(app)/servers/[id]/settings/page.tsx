import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { load, loadServer } from "@/lib/data";
import { PageHeader } from "@/components/page-header";
import { ServerForm } from "@/components/ServerForm";
import { AgentCard } from "@/components/servers/AgentCard";
import { agentFor } from "@/lib/agent";
import { agentUpdate } from "@/lib/agent-binaries-core";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { DeleteServerButton } from "@/components/DeleteServerButton";
import { AppsDomainCard } from "@/components/servers/AppsDomainCard";
import { PublicAddressCard } from "@/components/servers/PublicAddressCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { canRunApps } from "@/lib/machine-core";
import { serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Server settings", server.name);
}

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  const machine = !canRunApps(server);
  const relay = server.transport === "relay";
  const info = machine ? null : await load(agentFor(server).info());
  const running = info !== null && info.error === undefined ? info.data.version : null;
  const carried = bundledAgentVersion();

  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server, { label: "Settings" })}
        title="Server settings"
        description={<span className="font-mono text-xs">{relay ? "Connects to Keelson" : server.url}</span>}
      />
      <div className="space-y-10">
        {machine ? (
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>A computer that connects to Keelson</CardTitle>
              <CardDescription>
                This machine opened the connection itself and keeps it open, so it has no address, certificates, public IP or apps domain here. It does not serve traffic.
                To update its agent, download the new one on the machine and run <span className="font-mono">keelson-agent connect</span> again; there is nothing to install over SSH.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            <AgentCard serverId={id} running={running} carried={carried} state={agentUpdate(running ?? "", carried)} relay={relay} />
            {relay ? (
              <>
                <Card className="max-w-2xl">
                  <CardHeader>
                    <CardTitle>Connects to Keelson</CardTitle>
                    <CardDescription>
                      This server opened the connection itself and keeps it open, so it has no URL, certificates or token to manage here. It runs what you deploy to it and receives images built on other servers.
                    </CardDescription>
                  </CardHeader>
                </Card>
                <PublicAddressCard serverId={id} current={server.publicIp} />
              </>
            ) : (
              <ServerForm
                serverId={id}
                initial={{
                  name: server.name,
                  url: server.url,
                  caCert: server.caCert ?? "",
                  clientCert: server.clientCert ?? "",
                  canDeploy: server.canDeploy,
                  hasClientKey: server.hasClientKey,
                  publicIp: server.publicIp ?? "",
                }}
              />
            )}
            <AppsDomainCard serverId={id} current={server.appsDomain} />
          </>
        )}
        <Card className="max-w-2xl border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Danger zone</CardTitle>
            <CardDescription>
              {machine
                ? "Removing the machine revokes its connection: its agent is refused and stops. Nothing is deleted on the computer; delete ~/.keelson there to connect it again as a new machine."
                : relay
                  ? "Removing the server revokes its connection: its agent is refused. Running sites, its containers and its files are not affected; to connect it again, run the install command with a new code."
                  : "Removing the server only makes this dashboard forget it. Running sites, the agent and its containers are not affected."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm">Remove {server.name} from the dashboard.</p>
            <DeleteServerButton serverId={id} name={server.name} link={machine ? "machine" : relay ? "server" : "direct"} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
