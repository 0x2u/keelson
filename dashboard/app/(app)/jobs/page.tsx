import type { Metadata } from "next";
import { JobsTable } from "@/components/jobs/JobsTable";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { ListFilters } from "@/components/resource-list";
import { loadFleetLists } from "@/lib/fleet-lists";
import { addServers, filterJobs, filterUnanswered, listHref, listScope, parseListFilter } from "@/lib/resource-lists-core";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

/** Every scheduled job across the servers; `?server=` and `?project=` narrow it. It is no sidebar entry: it is reached from Home, the palette and the shortcuts. */
export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filter = parseListFilter(await searchParams);
  const lists = await loadFleetLists();
  const server = lists.servers.find((s) => s.id === filter.server);

  return (
    <>
      <PageHeader
        title="Jobs"
        description={
          filter.server
            ? `Scheduled jobs on ${server?.name ?? filter.server}${filter.project ? `, of project ${filter.project}` : ""}.`
            : filter.project
              ? `Scheduled jobs of project ${filter.project}, across its servers.`
              : "Every scheduled job across your servers: the ones that need a look come first."
        }
        actions={<LiveRefresh generatedAt={lists.generatedAt} />}
      />
      <div className="space-y-4">
        <ListFilters kind="jobs" filter={filter} servers={lists.servers} projects={lists.projects} />
        <JobsTable
          scope={listScope(filter)}
          entries={filterJobs(lists.jobs, filter)}
          unanswered={filterUnanswered(lists.unansweredJobs, filter)}
          servers={addServers(lists, filter)}
          from={listHref("jobs", filter)}
          filter={filter}
          now={lists.generatedAt}
        />
      </div>
    </>
  );
}
