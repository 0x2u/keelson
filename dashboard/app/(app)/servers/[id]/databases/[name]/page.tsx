import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ICONS } from "@/lib/icons";
import { agentFor } from "@/lib/agent";
import type { DatabaseBackup, DatabaseLive, DatabaseStatus, JobRun } from "@/lib/agent-types";
import { load, loadServer, type Loaded } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { GatedButton } from "@/components/GatedButton";
import { RunJobButton } from "@/components/RunJobButton";
import { JobRunList } from "@/components/JobRunList";
import { CopyButton } from "@/components/copy-button";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { RefreshWhile } from "@/components/databases/RefreshWhile";
import { RestoreDialog } from "@/components/databases/RestoreDialog";
import { ProveKeyDialog } from "@/components/readiness/ProveKeyDialog";
import { TestRestoreDialog } from "@/components/readiness/TestRestoreDialog";
import { LatestRuns } from "@/components/databases/LatestRuns";
import { anyRunning, highlightedRun, latestRun } from "@/lib/run-core";
import { entityCrumbs, serverListHref } from "@/lib/nav-core";
import { projectOfDatabase } from "@/lib/owner";

export async function generateMetadata({ params }: { params: Promise<{ id: string; name: string }> }): Promise<Metadata> {
  const { id, name } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(name), server.name, "Database");
}

export default async function DatabasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; name: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const [{ id, name }, { run }] = await Promise.all([params, searchParams]);
  const highlight = highlightedRun(run);
  const server = loadServer(id);
  const agent = agentFor(server);
  // Under its project's Databases tab when a project owns it, under the server's database list otherwise (see lib/owner-core).
  const crumbs = (owner: string | null) => entityCrumbs(owner, "databases", server, ...(owner === null ? [{ label: "Databases", href: `/databases?server=${encodeURIComponent(id)}` }] : []), { label: name });

  const databases = await load(agent.databases());
  if (databases.error !== undefined) {
    return (
      <>
        <PageHeader title={name} breadcrumbs={crumbs(null)} />
        <LoadError title={`Could not load ${server.name}`} back={{ href: serverListHref("databases", id), label: "Back to the databases" }}>
          {databases.error}
        </LoadError>
      </>
    );
  }
  const db = databases.data?.find((d) => d.name === name);
  if (!db) notFound();
  const breadcrumbs = crumbs(await projectOfDatabase(server, name, { databases: databases.data }));

  // Each of these can be slow or fail on its own (the database server, the backup destination): they stream in
  // separately and show their own error.
  const live = load(agent.databaseLive(db.name));
  const backups = db.backup ? load(agent.databaseBackups(db.name)) : undefined;
  const [backupRuns, restoreRuns] = await Promise.all([
    db.backup ? load(agent.jobRuns(db.backup.job, 10)) : undefined,
    load(agent.databaseRestores(db.name)),
  ]);
  const running = anyRunning(backupRuns?.data, restoreRuns.data);

  return (
    <>
      <RefreshWhile active={running} />
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={db.name}
        status={
          <>
            <Badge variant="outline">PostgreSQL</Badge>
            {db.backup?.paused && <Badge variant="muted">Backups paused</Badge>}
            {!db.backup && <Badge variant="muted">No backup</Badge>}
            {backupRuns?.data?.[0]?.status === "running" && <Badge variant="info">Backing up</Badge>}
            {restoreRuns.data?.[0]?.status === "running" && <Badge variant="info">Restoring</Badge>}
          </>
        }
        description={
          <span className="font-mono text-xs">
            {db.user}@{db.host}:{db.port}/{db.database}
          </span>
        }
        actions={
          <>
            <ConfigActionLink href={`/servers/${id}/config/databases/${encodeURIComponent(db.name)}`} enabled={server.canDeploy}>
              <ICONS.configuration />
              Edit configuration
            </ConfigActionLink>
            {db.backup && (
              <>
                <RunJobButton
                  serverId={id}
                  job={db.backup.job}
                  label="Back up now"
                  database={db.name}
                  disabled={backupRuns?.data?.[0]?.status === "running"}
                  canDeploy={server.canDeploy}
                />
                {server.canDeploy ? (
                  <Suspense fallback={null}>
                    <RestoreAction serverId={id} database={db} backups={backups} />
                  </Suspense>
                ) : (
                  <GatedButton canDeploy={false} variant="outline" size="sm">
                    Restore
                  </GatedButton>
                )}
              </>
            )}
          </>
        }
      />

      <div className="space-y-6">
        <LatestRuns backup={latestRun(backupRuns?.data)} restore={latestRun(restoreRuns.data)} />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="gap-4 py-4">
            <CardHeader>
              <CardTitle>Server</CardTitle>
              <CardDescription>Measured now through a throwaway client container.</CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<LiveSkeleton />}>
                <LiveFacts live={live} />
              </Suspense>
            </CardContent>
          </Card>
          <BackupSettings db={db} />
        </div>

        {db.backup && backups && (
          <Card className="gap-4 py-4">
            <CardHeader>
              <CardTitle>Backups</CardTitle>
              <CardDescription>What is stored at the destination, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Suspense fallback={<Skeleton className="mx-6 h-24" />}>
                <BackupList serverId={id} database={db} backups={backups} canRestore={server.canDeploy} />
              </Suspense>
            </CardContent>
          </Card>
        )}

        {backupRuns && (
          <RunsCard title="Backup runs" description="The 10 most recent runs, newest first." runs={backupRuns} empty="No backup has run yet." highlight={highlight} />
        )}
        <RunsCard
          title="Restores"
          description="Recent restores, newest first. A finished restore ends with the row count of each table, to compare with the source."
          runs={restoreRuns}
          empty="No restore yet."
          openFirst
          highlight={highlight}
        />
      </div>
    </>
  );
}

function BackupSettings({ db }: { db: DatabaseStatus }) {
  const backup = db.backup;
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <CardTitle>Backup</CardTitle>
        <CardDescription>Dumps are encrypted with age before they leave the server.</CardDescription>
      </CardHeader>
      <CardContent>
        {backup ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Schedule</dt>
            <dd>
              <span className="font-mono text-xs">{backup.schedule}</span>
              <span className="ml-2 text-xs text-muted-foreground">{backup.timezone}</span>
            </dd>
            <dt className="text-muted-foreground">Next run</dt>
            <dd>{backup.paused ? "Paused" : backup.next_run ? <RelativeTime at={backup.next_run} future /> : "–"}</dd>
            <dt className="text-muted-foreground">Destination</dt>
            <dd className="font-mono text-xs break-all">{backup.destination}</dd>
            <dt className="text-muted-foreground">Retention</dt>
            <dd>
              Newest {backup.keep}
              {backup.keep_days > 0 ? `, and nothing older than ${backup.keep_days} days` : ""}
            </dd>
            <dt className="text-muted-foreground">Encrypted to</dt>
            <dd>
              {backup.recipients} {backup.recipients === 1 ? "key" : "keys"}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            This database is declared without a backup section, so nothing is scheduled. Edit its configuration to add one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LiveSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading the database server">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-4 w-56" />
    </div>
  );
}

async function LiveFacts({ live }: { live: Promise<Loaded<DatabaseLive>> }) {
  const result = await live;
  if (result.error !== undefined) return <Notice title="The database cannot be reached">{result.error}</Notice>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Server version</dt>
      <dd className="tabular">PostgreSQL {result.data.server_version}</dd>
      <dt className="text-muted-foreground">Size</dt>
      <dd className="tabular">{formatBytes(result.data.size_bytes)}</dd>
      <dt className="text-muted-foreground">Client image</dt>
      <dd className="font-mono text-xs">{result.data.client_image}</dd>
    </dl>
  );
}

async function RestoreAction({
  serverId,
  database,
  backups,
}: {
  serverId: string;
  database: DatabaseStatus;
  backups: Promise<Loaded<DatabaseBackup[]>> | undefined;
}) {
  const result = await backups;
  if (!result || result.error !== undefined || result.data.length === 0) return null;
  // The restore checks are also on the project's Readiness tab; here they are one click from the database itself.
  return (
    <>
      <RestoreDialog serverId={serverId} name={database.name} database={database.database} backups={result.data} />
      <TestRestoreDialog serverId={serverId} name={database.name} backups={result.data} canDeploy />
      <ProveKeyDialog serverId={serverId} name={database.name} canDeploy />
    </>
  );
}

async function BackupList({
  serverId,
  database,
  backups,
  canRestore,
}: {
  serverId: string;
  database: DatabaseStatus;
  backups: Promise<Loaded<DatabaseBackup[]>>;
  canRestore: boolean;
}) {
  const result = await backups;
  if (result.error !== undefined) {
    return (
      <div className="px-6">
        <Notice title="The backup destination cannot be listed">{result.error}</Notice>
      </div>
    );
  }
  if (result.data.length === 0) {
    return (
      <EmptyState icon={ICONS.backup} title="No backup yet">
        The first one is made at the next scheduled time{canRestore ? ", or right now with Back up now" : ""}.
      </EmptyState>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Created</TableHead>
          <TableHead>Size</TableHead>
          <TableHead className="hidden md:table-cell">Key</TableHead>
          <TableHead className="pr-6">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.data.map((b) => (
          <TableRow key={b.key}>
            <TableCell className="pl-6">
              <RelativeTime at={b.created_at} />
            </TableCell>
            <TableCell className="tabular">{formatBytes(b.size_bytes)}</TableCell>
            <TableCell className="hidden max-w-72 font-mono text-xs text-muted-foreground md:table-cell">
              <span className="flex items-center gap-1">
                <span className="truncate" title={b.key}>
                  {b.key}
                </span>
                <CopyButton value={b.key} label="Copy key" />
              </span>
            </TableCell>
            <TableCell className="pr-6 text-right">
              {canRestore && (
                <RestoreDialog
                  serverId={serverId}
                  name={database.name}
                  database={database.database}
                  backups={result.data}
                  initialBackup={b.key}
                  size="xs"
                  variant="ghost"
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunsCard({
  title,
  description,
  runs,
  empty,
  openFirst,
  highlight,
}: {
  title: string;
  description: string;
  runs: Loaded<JobRun[]>;
  empty: string;
  openFirst?: boolean;
  highlight?: string;
}) {
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {runs.error !== undefined ? (
          <div className="px-6">
            <Notice title={`Could not load the ${title.toLowerCase()}`}>{runs.error}</Notice>
          </div>
        ) : runs.data.length === 0 ? (
          <EmptyState icon={ICONS.job} title={empty} />
        ) : (
          <JobRunList runs={runs.data} openFirst={openFirst} highlight={highlight} />
        )}
      </CardContent>
    </Card>
  );
}
