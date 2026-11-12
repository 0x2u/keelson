import { entityMetadata } from "@/lib/metadata";
import Link from "next/link";
import type { Metadata } from "next";
import { FileCode2Icon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { VersionsList } from "@/components/config/VersionsList";
import { serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Configuration history", server.name);
}

export default async function ConfigVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  const agent = agentFor(server);
  const [config, versions] = await Promise.all([load(agent.config()), load(agent.configVersions(50))]);
  const doc = config.error === undefined ? config.data : null;

  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server, { label: "Configuration", href: `/servers/${id}/config` }, { label: "History" })}
        title="Version history"
        description="Every saved configuration is kept. Restoring one writes it as a new version and applies it live, without a restart."
        actions={
          <Button asChild variant="outline">
            <Link href={`/servers/${id}/config`}>
              <FileCode2Icon />
              Open the editor
            </Link>
          </Button>
        }
      />

      {config.error !== undefined ? (
        <Notice title="Could not load the configuration">{config.error}</Notice>
      ) : doc === null ? (
        <Notice tone="info" title="Configuration is read-only">
          This agent runs without an apps file, so it keeps no configuration history.
        </Notice>
      ) : versions.error !== undefined ? (
        <Notice title="Could not load the version history">{versions.error}</Notice>
      ) : versions.data.length === 0 ? (
        <EmptyState icon={ICONS.history} title="No versions yet">
          The agent records a version each time the configuration changes, by the dashboard or by editing the file.
        </EmptyState>
      ) : (
        <VersionsList
          serverId={id}
          versions={versions.data}
          currentHash={doc.hash}
          currentContent={doc.content.replace(/\r\n?/g, "\n")}
          canEdit={server.canDeploy}
        />
      )}
    </>
  );
}
