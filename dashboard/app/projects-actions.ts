"use server";

import { AgentError, agentFor } from "@/lib/agent";
import { loadPlacements } from "@/lib/projects";
import { environmentOf, planPromotion } from "@/lib/projects-core";
import { getCredentials } from "@/lib/servers";
import { requireSession } from "@/lib/session";

export interface PromoteInput {
  fromServer: string;
  fromApp: string;
  toServer: string;
  toApp: string;
  /** The digest the operator saw when they opened the page: if the source changed since, nothing is deployed. */
  expectedDigest: string;
}

export interface PromoteState {
  error?: string;
  /** The deployment of the target app: the caller shows a toast linking to it and opens its log. */
  deploymentId?: string;
  /** The target app's name, for the toast. */
  app?: string;
}

/**
 * Deploys the exact digest serving in one environment to another. The digest is read again here, from the agent, not taken
 * from the browser: the page only says which version the operator believes they are promoting.
 */
export async function promoteAction(input: PromoteInput): Promise<PromoteState> {
  await requireSession();
  const { placements } = await loadPlacements();
  const from = placements.find((p) => p.server.id === input.fromServer && p.app.name === input.fromApp);
  const to = placements.find((p) => p.server.id === input.toServer && p.app.name === input.toApp);
  if (!from || !to) return { error: "One of the two apps could not be found: its server may be unreachable. Reload the page." };

  const plan = planPromotion(from, to);
  if (!plan.ok) return { error: plan.reason };
  if (plan.digest !== input.expectedDigest) {
    return { error: `The version serving in ${environmentOf(from.app)} changed since you opened this page. Reload to see it, then promote again.` };
  }

  let deploymentId: string;
  try {
    const creds = getCredentials(to.server.id);
    if (!creds) return { error: "This server is not in the dashboard any more." };
    deploymentId = await agentFor(creds).deploy(to.app.name, { digest: plan.digest }, "promotion");
  } catch (err) {
    return { error: err instanceof AgentError || err instanceof Error ? err.message : "unexpected error" };
  }
  return { deploymentId, app: to.app.name };
}
