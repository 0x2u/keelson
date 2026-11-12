import { LoadError } from "@/components/LoadError";
import { entityMetadata, routeName } from "@/lib/metadata";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ICONS } from "@/lib/icons";
import { actionIntent } from "@/lib/action-intent-core";
import { agentFor } from "@/lib/agent";
import { load, loadServer } from "@/lib/data";
import { jobConfigHref } from "@/lib/databases";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JobRunList } from "@/components/JobRunList";
import { RefreshWhile } from "@/components/databases/RefreshWhile";
import { anyRunning, highlightedRun } from "@/lib/run-core";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { RunJobButton } from "@/components/RunJobButton";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { entityCrumbs, serverListHref } from "@/lib/nav-core";
import { projectOfJob } from "@/lib/owner";

export async function generateMetadata({ params }: { params: Promise<{ id: string; name: string }> }): Promise<Metadata> {
  const { id, name } = await params;
  const server = loadServer(id);
  return entityMetadata(routeName(name), server.name, "Job");
}

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string; name: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id, name }, query] = await Promise.all([params, searchParams]);
  const { run } = query;
  const intent = actionIntent(query);
  const highlight = highlightedRun(run);
  const server = loadServer(id);
  const agent = agentFor(server);
  // Under its project's Jobs tab when a project owns it, under the server's job list otherwise (see lib/owner-core).
  const crumbs = (owner: string | null) => entityCrumbs(owner, "jobs", server, ...(owner === null ? [{ label: "Jobs", href: `/jobs?server=${encodeURIComponent(id)}` }] : []), { label: name });

  const [jobs, runs] = await Promise.all([load(agent.jobs()), load(agent.jobRuns(name, 50))]);
  if (jobs.error !== undefined) {
    return (
      <>
        <PageHeader title={name} breadcrumbs={crumbs(null)} />
        <LoadError title={`Could not load ${server.name}`} back={{ href: serverListHref("jobs", id), label: "Back to the jobs" }}>
          {jobs.error}
        </LoadError>
      </>
    );
  }
  const job = jobs.data?.find((j) => j.name === name);
  if (!job) notFound();
  const breadcrumbs = crumbs(await projectOfJob(server, name, { jobs: jobs.data }));

  return (
    <>
      <RefreshWhile active={job.running || anyRunning(runs.data)} />
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={job.name}
        status={
          <>
            {job.paused && <Badge variant="muted">Paused</Badge>}
            {job.running && <Badge variant="info">Running</Badge>}
          </>
        }
        description={
          <>
            <span className="font-mono text-xs">{job.schedule}</span>
            <span> ({job.timezone})</span>
            <span> · {job.target}</span>
            {job.next_run && !job.paused && (
              <>
                {" "}
                · next run <RelativeTime at={job.next_run} future />
              </>
            )}
          </>
        }
        actions={
          <>
            <ConfigActionLink href={jobConfigHref(id, job)} enabled={server.canDeploy}>
              <ICONS.configuration />
              Edit configuration
            </ConfigActionLink>
            <RunJobButton serverId={id} job={job.name} disabled={job.running} canDeploy={server.canDeploy} confirmOnOpen={intent.runNow} />
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>The 50 most recent runs, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {runs.error !== undefined ? (
            <div className="px-6">
              <Notice title="Could not load the runs">{runs.error}</Notice>
            </div>
          ) : runs.data.length === 0 ? (
            <EmptyState icon={ICONS.job} title="No run yet">
              {job.paused ? "This job is paused, so it will not run on its schedule." : "The first run happens at the next scheduled time."}
              {server.canDeploy && !job.paused ? " Use Run now to start one immediately." : ""}
            </EmptyState>
          ) : (
            <JobRunList runs={runs.data} highlight={highlight} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
