import type { Metadata } from "next";
import { Suspense } from "react";
import { DatabasesTable } from "@/components/databases/DatabasesTable";
import { DatabaseRestore } from "@/components/databases/DatabaseRestore";
import { BackupSize } from "@/components/home/BackupSize";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { ListFilters } from "@/components/resource-list";
import { loadFleetLists } from "@/lib/fleet-lists";
import { addServers, filterDatabases, filterUnanswered, listHref, listScope, parseListFilter } from "@/lib/resource-lists-core";

export const metadata: Metadata = { title: "Databases" };
export const dynamic = "force-dynamic";

/** Every database declared on the servers, with the state of its backups; `?server=` and `?project=` narrow it. It is no sidebar entry: it is reached from Home, the palette and the shortcuts. */
export default async function DatabasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filter = parseListFilter(await searchParams);
  const lists = await loadFleetLists();
  const server = lists.servers.find((s) => s.id === filter.server);
  const entries = filterDatabases(lists.databases, filter);

  return (
    <>
      <PageHeader
        title="Databases"
        description={
          filter.server
            ? `Databases on ${server?.name ?? filter.server}${filter.project ? `, of project ${filter.project}` : ""}, with the state of their backups.`
            : filter.project
              ? `Databases of project ${filter.project}, across its servers, with the state of their backups.`
              : "Every database declared on your servers, with the state of its backups: the ones that need a look come first."
        }
        actions={<LiveRefresh generatedAt={lists.generatedAt} />}
      />
      <div className="space-y-4">
        <ListFilters kind="databases" filter={filter} servers={lists.servers} projects={lists.projects} />
        <DatabasesTable
          scope={listScope(filter)}
          entries={entries}
          unanswered={filterUnanswered(lists.unansweredDatabases, filter)}
          servers={addServers(lists, filter)}
          from={listHref("databases", filter)}
          filter={filter}
          now={lists.generatedAt}
          restore={(serverId, name) => <DatabaseRestore serverId={serverId} name={name} database={entries.find((e) => e.server.id === serverId && e.db.name === name)?.db.database ?? name} />}
          backupSize={(serverId, database) => (
            <Suspense fallback={null}>
              <BackupSize serverId={serverId} database={database} />
            </Suspense>
          )}
        />
      </div>
    </>
  );
}
