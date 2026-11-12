import Link from "next/link";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { CantTell, UnansweredNotice, type Unanswered } from "@/components/fleet/Unreachable";
import { INLINE_LINK, InlineLink } from "@/components/layout";
import { RefreshWhile } from "@/components/databases/RefreshWhile";
import { RelativeTime } from "@/components/relative-time";
import { AddAction, UnassignedDetails } from "@/components/resource-list";
import { ResourceBody, ResourceCell, ResourceHead, ResourceHeadCell, ResourceRow, ResourceTable } from "@/components/resource-table";
import { RunJobButton } from "@/components/RunJobButton";
import { lastRunText, nextRunText } from "@/components/run-text";
import { EmptyState } from "@/components/states";
import { JobStateBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { JobStatus } from "@/lib/agent-types";
import { describeSchedule } from "@/lib/cron-describe";
import { ICONS } from "@/lib/icons";
import { projectHref } from "@/lib/nav-core";
import { jobEditHref, jobRows, jobRunsHref, jobsNeedingLook, jobViaText, type JobState } from "@/lib/project-hub-jobs-core";
import type { ServerRef } from "@/lib/projects-core";
import { addTargets, listHref, type JobEntry, type ListFilter, type ListScope } from "@/lib/resource-lists-core";

/** The run that last happened: one badge and when; the cause of a failure under it. Paused, running and never-run say that instead. */
function LastRun({ job, state }: { job: JobStatus; state: JobState }) {
  const run = job.last_run;
  if (state === "ok" || state === "failed") {
    return (
      <div className="space-y-1">
        {lastRunText(run)}
        {state === "failed" && run?.detail && (
          <p className="max-w-64 text-xs break-words text-destructive-text" title={run.detail}>
            {run.detail.length > 140 ? `${run.detail.slice(0, 137)}…` : run.detail}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <JobStateBadge state={state} />
      {state === "paused" && run && <RelativeTime at={run.started_at} className="text-xs text-muted-foreground" />}
    </div>
  );
}

/**
 * The scheduled jobs, one table for every place that lists them: `fleet` (all servers, with the project and the server of
 * each), `project` (one project's, across its servers: why each belongs, and what no app claims below) and `server` (one
 * server's). Failing jobs come first, then the ones that never ran, then paused ones. Run now and Edit are gated like every
 * other action: a read-only server's are disabled and say why. A server that did not answer is named, never silently absent.
 */
export function JobsTable({
  scope,
  entries,
  unanswered,
  servers,
  from,
  filter = {},
  unassigned = [],
  now,
}: {
  scope: ListScope;
  entries: JobEntry[];
  /** The servers whose jobs are unknown. */
  unanswered: Unanswered[];
  /** Where a job can be added (the servers that run things, or the project's). */
  servers: ServerRef[];
  /** Where Add and Edit return to: the address of the page that shows this table. */
  from: string;
  filter?: ListFilter;
  /** The jobs on the project's servers that no app claims (project scope only). */
  unassigned?: { server: ServerRef; job: JobStatus }[];
  /** When the lists were read: a job that has not run yet is late only when its first run is in the past. */
  now: number;
}) {
  const rows = jobRows(entries);
  const look = jobsNeedingLook(rows, now);
  const targets = addTargets("job", servers, from, filter);
  const showProject = scope !== "project";
  const showServer = scope !== "server";

  return (
    <div className="space-y-4">
      <RefreshWhile active={rows.some((r) => r.state === "running")} />
      {rows.length > 0 && <UnansweredNotice servers={unanswered} what="Jobs" />}
      {rows.length === 0 ? (
        unanswered.length > 0 ? (
          <Card>
            <CantTell servers={unanswered} what="Jobs" />
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
            Jobs run on a server. Add a server first, then add jobs to it.
          </EmptyState>
        ) : (
          <EmptyState bordered icon={ICONS.job} title={scope === "server" ? "No jobs on this server" : "No jobs yet"} action={<AddAction noun="job" targets={targets} primary />}>
            A job runs on a schedule: an HTTP request, a program on the server or a command in an app&apos;s container.
            {scope === "project" && " Jobs of this project's apps and the backups of their databases appear here."}
          </EmptyState>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Job summary">
              <Badge variant="muted">{rows.length === 1 ? "1 job" : `${rows.length} jobs`}</Badge>
              <Badge variant={look > 0 ? "warning" : "muted"}>{look} need a look</Badge>
            </div>
            <AddAction noun="job" targets={targets} />
          </div>
          <ResourceTable data-testid="jobs-table" data-scope={scope}>
            <ResourceHead>
              <ResourceHeadCell>Job</ResourceHeadCell>
              {showProject && <ResourceHeadCell from="sm">Project</ResourceHeadCell>}
              {showServer && <ResourceHeadCell from="sm">Server</ResourceHeadCell>}
              <ResourceHeadCell from="lg">Schedule</ResourceHeadCell>
              <ResourceHeadCell>Last run</ResourceHeadCell>
              <ResourceHeadCell from="md">Next run</ResourceHeadCell>
              <ResourceHeadCell className="text-right">
                <span className="sr-only">Actions</span>
              </ResourceHeadCell>
            </ResourceHead>
            <ResourceBody>
              {rows.map(({ entry, state }) => {
                const { server, job, project, hub } = entry;
                return (
                  <ResourceRow key={`${server.id}/${job.name}`} state={state} problem={state === "failed"}>
                    <ResourceCell className="max-w-48 sm:max-w-72">
                      <InlineLink href={jobRunsHref(server.id, job.name)} className="block truncate" title="Run history">
                        {job.name}
                      </InlineLink>
                      <p className="truncate text-xs text-muted-foreground" title={job.target}>
                        {job.kind} · {job.target}
                      </p>
                      {scope === "project" && hub && <p className="text-xs text-muted-foreground">{jobViaText(hub)}</p>}
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
                        <Link href={listHref("jobs", { server: server.id })} className={INLINE_LINK} title={`Jobs on ${server.name}`}>
                          {server.name}
                        </Link>
                      </ResourceCell>
                    )}
                    <ResourceCell from="lg" label="Schedule">
                      <p>{describeSchedule(job.schedule)}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {job.schedule} {job.timezone}
                      </p>
                    </ResourceCell>
                    <ResourceCell label="Last run">
                      <LastRun job={job} state={state} />
                    </ResourceCell>
                    <ResourceCell from="md" label="Next run" className="text-muted-foreground">
                      {nextRunText(job)}
                    </ResourceCell>
                    <ResourceCell className="sm:text-right">
                      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                        <ConfigActionLink href={jobEditHref(server.id, job, from)} enabled={server.canDeploy} variant="ghost" size="xs" aria-label={`Edit job ${job.name} on ${server.name}`}>
                          Edit
                        </ConfigActionLink>
                        <RunJobButton serverId={server.id} job={job.name} disabled={job.running} canDeploy={server.canDeploy} size="xs" />
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
        testId="unassigned-jobs"
        items={unassigned.map(({ server, job }) => ({
          key: `${server.id}/${job.name}`,
          name: job.name,
          href: jobRunsHref(server.id, job.name),
          meta: `${job.kind} · ${describeSchedule(job.schedule)} · ${server.name}`,
          openHref: listHref("jobs", { server: server.id }),
          openLabel: `Jobs on ${server.name}`,
        }))}
      />
    </div>
  );
}
