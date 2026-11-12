import Link from "next/link";
import { CircleCheckIcon, CircleDashedIcon, FileTextIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { ConfigEditor } from "@/components/config/ConfigEditor";
import { DeprecationsNotice } from "@/components/config/DeprecationsNotice";
import { CantTell, UnansweredNotice, type Unanswered } from "@/components/fleet/Unreachable";
import { GatedButton } from "@/components/GatedButton";
import { DeleteProjectFileDialog } from "@/components/projects/DeleteProjectFileDialog";
import { SplitProjectDialog } from "@/components/projects/SplitProjectDialog";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, Notice } from "@/components/states";
import { DefinitionItem, DefinitionList, InlineLink } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HIDDEN, type ProjectConfigDocument } from "@/lib/agent-types";
import {
  countsText,
  derivedCounts,
  derivedYaml,
  fileEntities,
  projectFileView,
  serverSectionId,
  VERSIONED_AS_A_WHOLE,
  versionsHref,
  type DerivedProject,
  type ServerProjectConfig,
} from "@/lib/project-config-core";

/** What the project holds on a server that keeps it in the shared apps file, written as the YAML it is. Read-only: secrets stay hidden. */
function DerivedView({ project, server, derived }: { project: string; server: string; derived: DerivedProject | null }) {
  if (derived === null) {
    return (
      <Notice title={`The configuration of ${server} could not be read`}>
        What {project} holds there cannot be shown until the server answers.
      </Notice>
    );
  }
  const text = derivedYaml(derived);
  return (
    <div className="space-y-2" data-testid="derived-config">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">What {project} holds on {server}</h3>
        <span className="text-xs text-muted-foreground">Read-only: taken from the server&apos;s merged configuration; secrets show as {HIDDEN}</span>
      </div>
      {text === "" ? (
        <p className="rounded-md border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
          Nothing in the configuration of {server} belongs to {project}: its apps are not declared there.
        </p>
      ) : (
        <pre
          tabIndex={0}
          aria-label={`Configuration of ${project} on ${server}, read-only YAML`}
          className="max-h-[min(60vh,32rem)] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre"
        >
          {text}
        </pre>
      )}
    </div>
  );
}


function UpdateNotice({ entry, project }: { entry: ServerProjectConfig; project: string }) {
  const { server, machine } = entry;
  return (
    <Notice
      tone="warning"
      title={`The agent on ${server.name} must be updated to give ${project} its own file`}
      action={
        machine ? undefined : (
          <InlineLink href={`/servers/${server.id}/update`} className="text-sm underline">
            Update the agent
          </InlineLink>
        )
      }
    >
      {machine
        ? `This agent does not know about per-project files. Download the current Keelson agent on ${server.name} and run keelson-agent connect again.`
        : "This agent does not know about per-project files. Update it from the server's page, then come back here."}{" "}
      Until then the configuration of {project} stays in the server&apos;s configuration, shown below read-only.
    </Notice>
  );
}

function FileSection({ entry, project, doc }: { entry: ServerProjectConfig; project: string; doc: ProjectConfigDocument }) {
  const { server } = entry;
  const view = projectFileView(doc);
  const holds = fileEntities(doc.model);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <DefinitionList data-testid="project-file-state">
            <DefinitionItem label="Where it lives">
              Its own file <span className="font-mono text-xs">{view.path}</span>
            </DefinitionItem>
            <DefinitionItem label="State">
              {view.inForce ? (
                <Badge variant="success">
                  <CircleCheckIcon aria-hidden />
                  In force
                </Badge>
              ) : (
                <Badge variant="warning" title="The agent runs a different configuration than the file on disk">
                  <CircleDashedIcon aria-hidden />
                  Not in force
                </Badge>
              )}
            </DefinitionItem>
            <DefinitionItem label="Holds">{countsText(view.counts)}</DefinitionItem>
            <DefinitionItem label="Last changed">
              <RelativeTime at={view.modifiedAt} />
              <span className="ml-2 font-mono text-xs text-muted-foreground" title={view.hash}>
                {view.hash.slice(0, 12)}
              </span>
            </DefinitionItem>
          </DefinitionList>
        </CardContent>
      </Card>

      {view.error !== undefined && (
        <Notice title={`The file on disk is not the one in force; ${server.name} keeps running the last good configuration`}>
          <span className="font-mono text-xs break-words">{view.error}</span>
          <span className="mt-2 block">The editor shows the file that is in force. Saving writes your text over the file on disk.</span>
        </Notice>
      )}

      <ConfigEditor
        key={view.hash}
        serverId={server.id}
        project={project}
        file={view.path}
        content={doc.content.replace(/\r\n?/g, "\n")}
        hash={view.hash}
        modifiedAt={view.modifiedAt}
        canEdit={server.canDeploy}
      />

      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <p className="min-w-0 flex-1 text-muted-foreground">{VERSIONED_AS_A_WHOLE}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={versionsHref(server.id)}>
            <ICONS.history />
            Version history of {server.name}
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 px-4 py-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Delete {view.path}</p>
          <p className="text-muted-foreground">
            Removes the file with {holds.length === 0 ? "nothing in it" : countsText(view.counts)}. {holds.length > 0 && "Those leave the configuration of this server."}
          </p>
        </div>
        {server.canDeploy ? (
          <DeleteProjectFileDialog
            serverId={server.id}
            serverName={server.name}
            project={project}
            file={view.path}
            hash={view.hash}
            holds={holds}
            appsLeave={view.counts.apps > 0}
          />
        ) : (
          <GatedButton canDeploy={false} type="button" variant="destructive">
            Delete {view.path}
          </GatedButton>
        )}
      </div>
    </div>
  );
}

function SharedSection({ entry, project }: { entry: ServerProjectConfig; project: string }) {
  const { server, derived } = entry;
  const old = entry.source === "old-agent";
  return (
    <div className="space-y-4">
      {old && <UpdateNotice entry={entry} project={project} />}
      <Card>
        <CardContent>
          <DefinitionList className="sm:grid-cols-2 lg:grid-cols-2" data-testid="project-file-state">
            <DefinitionItem label="Where it lives">The shared configuration of {server.name}</DefinitionItem>
            <DefinitionItem label="Holds">{derived === null ? "Not known: the configuration could not be read" : countsText(derivedCounts(derived))}</DefinitionItem>
          </DefinitionList>
        </CardContent>
      </Card>
      <DerivedView project={project} server={server.name} derived={derived} />
      {!old && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            A file of its own (<span className="font-mono text-xs">projects.d/{project}.yaml</span>) keeps {project} apart from the other projects of {server.name} and is edited
            here. You see what would move before anything is written.
          </p>
          <SplitProjectDialog serverId={server.id} serverName={server.name} project={project} canEdit={server.canDeploy} />
        </div>
      )}
    </div>
  );
}

function ServerSection({ entry, project }: { entry: ServerProjectConfig; project: string }) {
  const { server } = entry;
  return (
    <section id={serverSectionId(server.id)} aria-labelledby={`${serverSectionId(server.id)}-title`} className="scroll-mt-20 space-y-4" data-testid="server-config" data-server={server.id}>
      <Card>
        <CardHeader>
          <CardTitle id={`${serverSectionId(server.id)}-title`} className="flex flex-wrap items-center gap-2">
            <FileTextIcon aria-hidden className="size-4 text-muted-foreground" />
            Configuration on{" "}
            <InlineLink href={`/servers/${server.id}/config`}>{server.name}</InlineLink>
          </CardTitle>
          <CardDescription>
            {entry.source === "file"
              ? `${project} has its own file on this server.`
              : entry.source === "unavailable"
                ? `The server did not say where ${project} is configured.`
                : `${project} is configured in the server's shared configuration.`}
          </CardDescription>
        </CardHeader>
      </Card>
      {entry.source === "unavailable" && (
        <Notice
          title={`Could not read the configuration of ${project} on ${server.name}`}
          action={
            <InlineLink href={`/servers/${server.id}`} className="text-sm underline">
              Open {server.name}
            </InlineLink>
          }
        >
          {entry.reason}
        </Notice>
      )}
      <DeprecationsNotice issues={entry.deprecations} />
      {entry.source === "file" && <FileSection entry={entry} project={project} doc={entry.doc} />}
      {(entry.source === "shared" || entry.source === "old-agent") && <SharedSection entry={entry} project={project} />}
    </section>
  );
}

/**
 * Where the project's configuration lives, one section per server that holds one of its apps: its own file, edited here with
 * the same check, review and save as the server's configuration; or the shared apps file, shown as the project's entries and
 * with the way to give the project its own file. Servers that did not answer are named, never skipped.
 */
export function ProjectConfig({ project, servers, unreachable }: { project: string; servers: ServerProjectConfig[]; unreachable: Unanswered[] }) {
  if (servers.length === 0) {
    return unreachable.length > 0 ? (
      <Card>
        <CantTell servers={unreachable} what="The configuration of this project" />
      </Card>
    ) : (
      <EmptyState bordered icon={ICONS.configuration} title="No servers yet">
        The configuration of a project is read from the servers that run its apps. Add an app to this project to see it here.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-8">
      <UnansweredNotice servers={unreachable} what="The configuration of this project" />
      {servers.map((entry) => (
        <ServerSection key={entry.server.id} entry={entry} project={project} />
      ))}
    </div>
  );
}
