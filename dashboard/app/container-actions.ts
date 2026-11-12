"use server";

import { revalidatePath } from "next/cache";
import { AgentError, agentFor } from "@/lib/agent";
import { getCredentials } from "@/lib/servers";
import { audit } from "@/lib/auth/store";
import { clientInfo, requireSession } from "@/lib/session";

export interface ContainerActionState {
  error?: string;
}

/**
 * Starts or restarts a container the agent manages. The dashboard records `container_start` / `container_restart` in its
 * audit log (the agent keeps its own entry). A failure comes back as text: an agent too old for these routes says so.
 */
export async function containerAction(serverId: string, container: string, action: "start" | "restart"): Promise<ContainerActionState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  if (action !== "start" && action !== "restart") return { error: "Unknown action." };
  const ip = (await clientInfo()).ip;
  try {
    await agentFor(server).containerAction(container, action);
  } catch (err) {
    const error = err instanceof AgentError ? err.message : "unexpected error talking to the agent";
    audit(`container_${action}_failed`, `${server.name}: ${container}: ${error}`, ip);
    return { error };
  }
  audit(`container_${action}`, `${server.name}: ${container}`, ip);
  revalidatePath(`/servers/${serverId}`, "layout");
  return {};
}
