import type { Deployment, JobStatus } from "@/lib/agent-types";

/**
 * What the agent is in the middle of: stopping it then would leave a deployment half done (a new container started and
 * the old one still serving) or kill a job's run. One line per thing, for the operator to read.
 */
export function busyWork(deployments: Deployment[], jobs: JobStatus[] | null): string[] {
  const busy: string[] = [];
  for (const d of deployments) if (d.status === "running") busy.push(`a deployment of ${d.app} (${d.ref})`);
  for (const j of jobs ?? []) if (j.running) busy.push(`the job ${j.name}`);
  return busy;
}
