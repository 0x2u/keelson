import type { JobStatus } from "@/lib/agent-types";

/** A database's scheduled backup is a job the agent derives from the database: "backup-<name>". */
const BACKUP_JOB_PREFIX = "backup-";

/** The configuration page of a job. A backup job is not in the jobs of the configuration: its database is. */
export function jobConfigHref(serverId: string, job: Pick<JobStatus, "name" | "kind">): string {
  if (job.kind === "backup") return `/servers/${serverId}/config/databases/${encodeURIComponent(job.name.slice(BACKUP_JOB_PREFIX.length))}`;
  return `/servers/${serverId}/config/jobs/${job.name}`;
}
