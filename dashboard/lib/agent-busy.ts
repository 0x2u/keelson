import "server-only";
import { AgentError, agentFor } from "@/lib/agent";
import type { ServerCredentials } from "@/lib/servers";
import { busyWork } from "@/lib/uninstall-core";

/**
 * The deployments and jobs under way on the agent, read through the dashboard's own connection. Replacing or removing the
 * agent while one runs interrupts it (a migration cut in half, a backup abandoned). Unreachable: nothing to ask.
 */
export async function currentlyBusy(server: ServerCredentials): Promise<{ reachable: boolean; busy: string[] }> {
  const agent = agentFor(server);
  try {
    const deployments = await agent.deployments(undefined, 20);
    const jobs = await agent.jobs();
    return { reachable: true, busy: busyWork(deployments, jobs) };
  } catch (err) {
    // A read-only agent has no deployments route (404) but answers: only a network failure means unreachable.
    return { reachable: !(err instanceof AgentError && err.status === 0), busy: [] };
  }
}
