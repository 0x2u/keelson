import Link from "next/link";
import type { ReactNode } from "react";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { CantTell, UnansweredNotice, type Unanswered } from "@/components/fleet/Unreachable";
import { GatedButton } from "@/components/GatedButton";
import { INLINE_LINK, InlineLink } from "@/components/layout";
import { RelativeTime } from "@/components/relative-time";
import { RefreshWhile } from "@/components/databases/RefreshWhile";
import { AddAction, UnassignedDetails } from "@/components/resource-list";
import { ResourceBody, ResourceCell, ResourceHead, ResourceHeadCell, ResourceRow, ResourceTable } from "@/components/resource-table";
import { RunJobButton } from "@/components/RunJobButton";
import { nextRunText } from "@/components/run-text";
import { EmptyState } from "@/components/states";
import { BackupBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DatabaseStatus } from "@/lib/agent-types";
import { isProblem } from "@/lib/databases-fleet-core";
import { ICONS } from "@/lib/icons";
import { projectHref } from "@/lib/nav-core";
import {
  databaseEditHref,
  databaseEntryRows,
  databasePageHref,
  databaseViaText,
  retentionText,
  versionText,
} from "@/lib/project-hub-jobs-core";
import type { ServerRef } from "@/lib/projects-core";
import { addTargets, listHref, type DatabaseEntry, type ListFilter, type ListScope } from "@/lib/resource-lists-core";

/**
 * The databases, one table for every place that lists them: `fleet` (all servers, with the project and the server of each),
 * `project` (one project's, across its servers: why each belongs, and what no app claims below) and `server` (one server's).
 * The backups that need a look come first (failed, overdue, not backed up, paused). Back up now, Restore and Edit are gated
 * like every other action: a read-only server's are disabled and say why. A server that did not answer is named, never
 * silently absent.
 */
export function DatabasesTable({
  scope,
  entries,
  unanswered,
  servers,
  from,
  now,
  filter = {},
  unassigned = [],
  restore,
  backupSize,
}: {
  scope: ListScope;
  entries: DatabaseEntry[];
  /** The servers whose databases are unknown. */
  unanswered: Unanswered[];
  /** Where a database can be added (the servers that run things, or the project's). */
  servers: ServerRef[];
  /** Where Add and Edit return to: the address of the page that shows this table. */
  from: string;
  /** The time the page was read: what "overdue" is judged against. */
  now: number;
  filter?: ListFilter;
  /** The databases on the project's servers that no app claims (project scope only). */
  unassigned?: { server: ServerRef; db: DatabaseStatus }[];
  /** The Restore action of a database. It needs the backups listed at the destination, which the page streams in; without it Restore links to the database's page. */
  restore?: (serverId: string, database: string) => ReactNode;
  /** The size of a database's newest backup, read from its destination and streamed on its own. */
  backupSize?: (serverId: string, database: string) => ReactNode;
}) {
  const rows = databaseEntryRows(entries, now);
  const look = rows.filter((r) => isProblem(r.state)).length;
  const targets = addTargets("database", servers, from, filter);
  const showProject = scope !== "project";
  const showServer = scope !== "server";

  return (
    <div className="space-y-4">
      <RefreshWhile active={rows.some((r) => r.state === "running")} />
      {rows.length > 0 && <UnansweredNotice servers={unanswered} what="Databases" />}
      {rows.length === 0 ? (
        unanswered.length > 0 ? (
          <Card>
            <CantTell servers={unanswered} what="Databases" />
          </Card>
        ) : servers.length === 0 && scope === "fleet" ? (
          <EmptyState
            bordered
            icon={ICONS.server}
            title="No servers yet"
            action={
              <Link href="/servers/new" className="text-sm font-medium underline-offset-4 hover:underline">
                Add a server
              </Link>
            }
          >
            Databases live on a server. Add a server first, then add its databases.
          </EmptyState>
        ) : (
          <EmptyState bordered icon={ICONS.database} title={scope === "server" ? "No databases on this server" : "No databases yet"} action={<AddAction noun="database" targets={targets} primary />}>
            Declare an existing PostgreSQL database to back it up on a schedule and restore it.
            {scope === "project" && " Databases managed by this project's apps, or backed up before their release, appear here."}
          </EmptyState>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Database summary">
              <Badge variant="muted">{rows.length === 1 ? "1 database" : `${rows.length} databases`}</Badge>
              <Badge variant={look > 0 ? "warning" : "muted"}>{look} need a look</Badge>
            </div>
            <AddAction noun="database" targets={targets} />
          </div>
          <ResourceTable data-testid="databases-table" data-scope={scope}>
            <ResourceHead>
              <ResourceHeadCell>Database</ResourceHeadCell>
              {showProject && <ResourceHeadCell from="sm">Project</ResourceHeadCell>}
              {showServer && <ResourceHeadCell from="sm">Server</ResourceHeadCell>}
              <ResourceHeadCell>Backup</ResourceHeadCell>
              <ResourceHeadCell from="md">Last backup</ResourceHeadCell>
              <ResourceHeadCell from="lg">Next backup</ResourceHeadCell>
              <ResourceHeadCell className="text-right">
                <span className="sr-only">Actions</span>
              </ResourceHeadCell>
            </ResourceHead>
            <ResourceBody>
              {rows.map(({ entry, state, detail }) => {
                const { server, db, project, hub } = entry;
                const backup = db.backup;
                const run = backup?.last_run;
                const restoreNode = restore ? (
                  restore(server.id, db.name)
                ) : (
                  <Button asChild variant="outline" size="xs">
                    <Link href={databasePageHref(server.id, db.name)}>Restore</Link>
                  </Button>
                );
                return (
                  <ResourceRow key={`${server.id}/${db.name}`} state={state} problem={state === "failed"}>
                    <ResourceCell className="max-w-48 sm:max-w-72">
                      <InlineLink href={databasePageHref(server.id, db.name)} className="block truncate">
                        {db.name}
                      </InlineLink>
                      <p className="truncate font-mono text-xs text-muted-foreground" title={`${db.host}:${db.port}/${db.database}`}>
                        {versionText(db.engine, db.version)} · {db.host}:{db.port}/{db.database}
                      </p>
                      {scope === "project" && hub && <p className="text-xs text-muted-foreground">{databaseViaText(hub)}</p>}
                    </ResourceCell>
                    {showProject && (
                      <ResourceCell from="sm" label="Project">
                        {project ? (
                          <Link href={projectHref(project)} className={INLINE_LINK}>
                            {project}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">–</span>
                        )}
                      </ResourceCell>
                    )}
                    {showServer && (
                      <ResourceCell from="sm" label="Server">
                        <Link href={listHref("databases", { server: server.id })} className={INLINE_LINK} title={`Databases on ${server.name}`}>
                          {server.name}
                        </Link>
                      </ResourceCell>
                    )}
                    <ResourceCell label="Backup">
                      <div className="space-y-1">
                        <BackupBadge state={state} />
                        {detail && (
                          <p className="max-w-64 text-xs break-words text-muted-foreground" title={detail}>
                            {detail.length > 140 ? `${detail.slice(0, 137)}…` : detail}
                          </p>
                        )}
                        {backup && <p className="text-xs text-muted-foreground">{retentionText(backup)}</p>}
                      </div>
                    </ResourceCell>
                    <ResourceCell from="md" label="Last backup">
                      {run ? (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <RelativeTime at={run.finished_at ?? run.started_at} className="text-muted-foreground" />
                          {backupSize && <span className="text-xs text-muted-foreground">{backupSize(server.id, db.name)}</span>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{backup ? "No backup yet" : "–"}</span>
                      )}
                    </ResourceCell>
                    <ResourceCell from="lg" label="Next backup" className="text-muted-foreground">
                      {nextRunText(backup ? { running: run?.status === "running", paused: backup.paused, next_run: backup.next_run } : null)}
                    </ResourceCell>
                    <ResourceCell className="sm:text-right">
                      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                        <ConfigActionLink href={databaseEditHref(server.id, db.name, from)} enabled={server.canDeploy} variant="ghost" size="xs" aria-label={`Edit database ${db.name} on ${server.name}`}>
                          Edit
                        </ConfigActionLink>
                        {backup && (
                          <>
                            <RunJobButton serverId={server.id} job={backup.job} label="Back up now" database={db.name} disabled={run?.status === "running"} canDeploy={server.canDeploy} size="xs" />
                            {server.canDeploy ? (
                              restoreNode
                            ) : (
                              <GatedButton canDeploy={false} variant="outline" size="xs">
                                Restore
                              </GatedButton>
                            )}
                          </>
                        )}
                      </div>
                    </ResourceCell>
                  </ResourceRow>
                );
              })}
            </ResourceBody>
          </ResourceTable>
        </>
      )}
      <UnassignedDetails
        testId="unassigned-databases"
        items={unassigned.map(({ server, db }) => ({
          key: `${server.id}/${db.name}`,
          name: db.name,
          href: databasePageHref(server.id, db.name),
          meta: `${versionText(db.engine, db.version)} · ${server.name}`,
          openHref: listHref("databases", { server: server.id }),
          openLabel: `Databases on ${server.name}`,
        }))}
      />
    </div>
  );
}
