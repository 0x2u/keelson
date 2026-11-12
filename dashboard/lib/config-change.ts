import "server-only";
import { revalidatePath } from "next/cache";
import { AgentError, agentFor, type AgentClient } from "@/lib/agent";
import type { ConfigIssue, ConfigModel, SaveResult } from "@/lib/agent-types";
import { getCredentials } from "@/lib/servers";
import { requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import type { StepUp } from "@/lib/step-up-core";

// What every configuration action of the dashboard does around the agent's call: needs a session, finds the server,
// asks for the step-up a sensitive change needs, refreshes the pages that show configuration, and turns a failure
// into a result. The actions (app/config-actions.ts, app/project-config-actions.ts) only say which call and what is sensitive.

/** A configuration change: what the agent said, or why it could not be asked. */
export type ConfigActionResult = SaveResult | { ok: false; kind: "error"; message: string; issues: ConfigIssue[] };

export function failure(err: unknown): { ok: false; kind: "error"; message: string; issues: ConfigIssue[] } {
  return { ok: false, kind: "error", message: err instanceof AgentError ? err.message : "unexpected error talking to the agent", issues: [] };
}

export async function agentOf(serverId: string): Promise<AgentClient | null> {
  await requireSession();
  const server = getCredentials(serverId);
  return server ? agentFor(server) : null;
}

/** Refreshes every page that shows a server's configuration: its own pages and the project hubs that read it. */
export function refreshConfigPages(serverId: string): void {
  revalidatePath(`/servers/${serverId}`, "layout");
  revalidatePath("/projects", "layout");
}

/**
 * Runs one change, then refreshes every page that shows configuration. A change that decides what the server runs or where
 * things go (see lib/step-up-core.ts) needs the session to be unlocked first: `sensitive` looks at what is stored now and
 * says so. When what is stored cannot be read, the change is treated as a new one.
 */
export async function change(
  serverId: string,
  run: (agent: AgentClient) => Promise<SaveResult>,
  sensitive?: { what: string; check: (before: ConfigModel | null) => StepUp },
): Promise<ConfigActionResult> {
  const agent = await agentOf(serverId);
  if (!agent) return { ok: false, kind: "error", message: "Unknown server.", issues: [] };
  if (sensitive) {
    let before: ConfigModel | null = null;
    try {
      before = (await agent.config())?.model ?? null;
    } catch {
      /* unreadable: treated as nothing stored */
    }
    const blocked = await stepUpError(sensitive.check(before), sensitive.what);
    if (blocked) return { ok: false, kind: "error", message: blocked, issues: [] };
  }
  try {
    const result = await run(agent);
    if (result.ok) refreshConfigPages(serverId);
    return result;
  } catch (err) {
    return failure(err);
  }
}
