import "server-only";
import { AgentError, agentFor, type AgentClient } from "@/lib/agent";
import type { JobStatus } from "@/lib/agent-types";
import { buildFeed, WINDOWS, type ActivityFilter, type Feed, type RunInput, type ServerActivity } from "@/lib/activity-core";
import { recentAudit } from "@/lib/auth/store";
import { load, type Loaded } from "@/lib/data";
import { triggerLabel } from "@/lib/labels-core";
import { projectOf } from "@/lib/projects-core";
import { getCredentials, listServers } from "@/lib/servers";

// What each agent is asked for, per server, to fill the feed. Every list is bounded: the feed is the latest events, not
// an archive (the server's own pages go further back).
const DEPLOYMENTS = 100;
const AUDIT = 100;
const VERSIONS = 100;
const JOBS = 30;
const RUNS_PER_JOB = 10;
const DATABASES = 10;
const DASHBOARD_AUDIT = 200;
const ALERTS = 200;

/** An agent without this part of the API answers 404: that is an empty list, not a failure. */
async function orEmpty<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof AgentError && err.status === 404) return [];
    throw err;
  }
}

const containerApp = (job: JobStatus): string | undefined => /^container of (.+)$/.exec(job.target)?.[1];

/** The runs worth asking for: a job with no run inside the window has nothing to show. */
function jobsWithRecentRuns(jobs: JobStatus[], since: number): JobStatus[] {
  return jobs
    .filter((j) => j.last_run !== undefined && Date.parse(j.last_run.started_at) >= since)
    .sort((a, b) => Date.parse(b.last_run?.started_at ?? "") - Date.parse(a.last_run?.started_at ?? ""))
    .slice(0, JOBS);
}

interface Fetched {
  runs: RunInput[];
  error?: string;
}

async function serverActivity(s: { id: string; name: string }, window: number, now: number): Promise<ServerActivity> {
  const server = { id: s.id, name: s.name };
  const empty: ServerActivity = { server, deployments: [], runs: [], audit: [], versions: [], projects: {}, gaps: [] };
  const creds = getCredentials(s.id);
  if (!creds) return { ...empty, unreachable: "this server is no longer registered" };
  const agent: AgentClient = agentFor(creds);

  // The deployments tell whether the server answers at all: when they cannot be read, nothing else is tried.
  const deployments = await load(orEmpty(agent.deployments(undefined, DEPLOYMENTS)));
  if (deployments.error !== undefined) return { ...empty, unreachable: deployments.error };

  const [jobs, databases, apps, audit, versions, alerts] = await Promise.all([
    load(agent.jobs()),
    load(agent.databases()),
    load(agent.apps()),
    load(orEmpty(agent.audit(AUDIT))),
    load(orEmpty(agent.configVersions(VERSIONS))),
    load(agent.notificationHistory(ALERTS)),
  ]);
  const gaps: ServerActivity["gaps"] = [];
  const note = (source: string, out: Loaded<unknown>) => {
    if (out.error !== undefined) gaps.push({ source, reason: out.error });
  };
  note("job list", jobs);
  note("databases", databases);
  note("apps", apps);
  note("audit log", audit);
  note("alert history", alerts);

  const since = now - window;
  const runs: RunInput[] = [];
  const runJobs = jobsWithRecentRuns(jobs.data ?? [], since);
  const fetched: Fetched[] = await Promise.all([
    ...runJobs.map(async (job): Promise<Fetched> => {
      const out = await load(agent.jobRuns(job.name, RUNS_PER_JOB));
      if (out.error !== undefined) return { error: out.error, runs: [] };
      const database = job.kind === "backup" ? { name: job.name.replace(/^backup-/, ""), what: "backup" as const } : undefined;
      return { runs: out.data.map((run): RunInput => ({ run, job: job.name, database, app: containerApp(job) })) };
    }),
    ...(databases.data ?? []).slice(0, DATABASES).map(async (db): Promise<Fetched> => {
      const out = await load(agent.databaseRestores(db.name));
      if (out.error !== undefined) return { error: out.error, runs: [] };
      return { runs: out.data.map((run): RunInput => ({ run, job: run.job, database: { name: db.name, what: "restore" } })) };
    }),
  ]);
  for (const f of fetched) runs.push(...f.runs);
  const failedRuns = fetched.find((f) => f.error !== undefined);
  if (failedRuns?.error !== undefined) gaps.push({ source: "job runs", reason: failedRuns.error });

  return {
    server,
    deployments: deployments.data,
    runs,
    audit: audit.data ?? [],
    versions: versions.data ?? [],
    ...(alerts.data === null || alerts.data === undefined ? {} : { alerts: alerts.data }),
    projects: Object.fromEntries((apps.data ?? []).map((a) => [a.name, projectOf(a)])),
    gaps,
  };
}

/** The feed for a filter: every server asked at once, the dashboard's own audit entries added. */
export async function loadActivity(filter: ActivityFilter): Promise<Feed> {
  const now = Date.now();
  const servers = await Promise.all(listServers().map((s) => serverActivity(s, WINDOWS[filter.window], now)));
  return buildFeed({ servers, dashboard: recentAudit(DASHBOARD_AUDIT), now, filter, trigger: triggerLabel });
}
