import { entityMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { agentFor } from "@/lib/agent";
import { agentUpdate } from "@/lib/agent-binaries-core";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { load, loadServer } from "@/lib/data";
import { PageHeader } from "@/components/page-header";
import { RelayUpdate } from "@/components/servers/RelayCommands";
import { SshInstallWizard } from "@/components/servers/SshInstallWizard";
import { Notice } from "@/components/states";
import { canRunApps } from "@/lib/machine-core";
import { releaseCheck } from "@/lib/release-check";
import { updateCommand } from "@/lib/release-check-core";
import { InlineLink } from "@/components/layout";
import { CodeBlock } from "@/components/servers/install-outcome";
import { serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Update the agent", server.name);
}

export default async function UpdateAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  // A server that does not serve traffic is updated on the machine itself: nothing to offer here.
  if (!canRunApps(server)) redirect(`/servers/${id}/settings`);
  const relay = server.transport === "relay";
  const info = await load(agentFor(server).info());
  const running = info.error === undefined ? info.data.version : "";
  const carried = bundledAgentVersion();
  const state = agentUpdate(running, carried);
  // Only a dashboard that is behind needs the command: the check may call GitHub, so it is not made for the other states.
  const release = state === "newer" ? await releaseCheck() : null;

  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server, { label: "Update the agent" })}
        title="Update the agent"
        description={
          <>
            Running <span className="font-mono">{running || "unknown"}</span>, this dashboard carries <span className="font-mono">{carried ?? "unknown"}</span>.
            {state === "current" && (relay ? " Updating again reinstalls the same version." : " Updating again reinstalls the same version and renews this dashboard's client certificate.")}
          </>
        }
      />
      <div className="max-w-3xl space-y-6">
        {state === "newer" ? (
          <Notice tone="warning" title="Newer than this dashboard">
            <div className="space-y-2">
              <p>
                The agent runs a newer version than the one this dashboard carries, and replacing it would be a downgrade. Update the dashboard first (back it up in <InlineLink href="/settings/backup">Settings, Backup</InlineLink>), then
                update the agent here.
              </p>
              {release?.status === "newer" && release.latest ? (
                <>
                  <p>
                    Run this on the machine that hosts the dashboard to update it to {release.latest.tag}; <InlineLink href="/settings#settings-about">Settings, About</InlineLink> has the steps.
                  </p>
                  <CodeBlock value={updateCommand(release.latest.tag)} label="Copy the update command" />
                </>
              ) : (
                <p>
                  <InlineLink href="/settings#settings-about">Settings, About</InlineLink> shows the latest release and how to update to it.
                </p>
              )}
            </div>
          </Notice>
        ) : (
          <>
            {!relay && info.error !== undefined && (
              <Notice tone="warning" title="The agent does not answer">
                {info.error} Updating over SSH can still work, and replaces the agent with a fresh copy.
              </Notice>
            )}
            {relay ? <RelayUpdate serverId={id} serverName={server.name} /> : <SshInstallWizard upgrade={{ serverId: id, host: new URL(server.url).hostname }} />}
          </>
        )}
      </div>
    </>
  );
}
