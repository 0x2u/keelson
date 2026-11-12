import { LoadError } from "@/components/LoadError";
import { entityMetadata } from "@/lib/metadata";
import Link from "next/link";
import type { Metadata } from "next";
import { CircleCheckIcon, CircleDashedIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { agentFor } from "@/lib/agent";
import { HIDDEN } from "@/lib/agent-types";
import { load, loadServer } from "@/lib/data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { notificationsHref } from "@/lib/redirects-core";
import { Notice } from "@/components/states";
import { ConfigEditor } from "@/components/config/ConfigEditor";
import { ConfigFiles } from "@/components/config/ConfigFiles";
import { DeprecationsNotice } from "@/components/config/DeprecationsNotice";
import { configFileRows } from "@/lib/project-config-core";
import { serverCrumbs } from "@/lib/nav-core";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const server = loadServer(id);
  return entityMetadata("Configuration", server.name);
}

export default async function ConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = loadServer(id);
  const result = await load(agentFor(server).config());
  const doc = result.error === undefined ? result.data : null;
  const files = configFileRows(doc?.files);

  return (
    <>
      <PageHeader
        breadcrumbs={serverCrumbs(server, { label: "Configuration" })}
        title="Configuration"
        description={
          <>
            The file lives on the agent and is read live, without a restart. A change to an app&apos;s container (variables, command, volumes, ports, health check) takes effect at its next deployment; domains, jobs and notifications apply at once. Secrets show as{" "}
            <code className="font-mono text-xs">{HIDDEN}</code>: leave one as it is to keep the stored value.
          </>
        }
        actions={
          doc && (
            <>
              {doc.applied_hash === doc.hash ? (
                <Badge variant="muted">
                  <CircleCheckIcon aria-hidden />
                  {files.length > 0 ? "Running this configuration" : "Running this file"}
                </Badge>
              ) : (
                <Badge variant="warning" title="The agent runs a different configuration than the one on disk">
                  <CircleDashedIcon aria-hidden />
                  {files.length > 0 ? "Not running this configuration" : "Not running this file"}
                </Badge>
              )}
              <Button asChild variant="outline">
                <Link href={notificationsHref(id)}>
                  <ICONS.notification />
                  Notifications
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/servers/${id}/config/versions`}>
                  <ICONS.history />
                  Version history
                </Link>
              </Button>
            </>
          )
        }
      />

      {result.error !== undefined ? (
        <LoadError title="Could not load the configuration" back={{ href: `/servers/${id}`, label: "Back to the server" }}>
          {result.error}
        </LoadError>
      ) : doc === null ? (
        <Notice tone="info" title="Configuration is read-only">
          This agent runs without an apps file, so there is no configuration to edit from the dashboard.
        </Notice>
      ) : (
        <div className="space-y-4">
          {doc.error !== undefined && (
            <Notice title="The file on disk is invalid; the agent keeps running the last good configuration">
              <span className="font-mono text-xs break-words">{doc.error}</span>
            </Notice>
          )}
          <DeprecationsNotice issues={doc.deprecations} />
          {files.length > 0 && <ConfigFiles rows={files} />}
          <ConfigEditor
            key={doc.hash}
            file={files[0]?.path}
            serverId={id}
            content={doc.content.replace(/\r\n?/g, "\n")}
            hash={doc.hash}
            modifiedAt={doc.modified_at}
            canEdit={server.canDeploy}
          />
        </div>
      )}
    </>
  );
}
