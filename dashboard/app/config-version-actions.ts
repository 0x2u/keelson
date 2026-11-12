"use server";

import { AgentError, agentFor } from "@/lib/agent";
import { getCredentials } from "@/lib/servers";
import { requireSession } from "@/lib/session";

/** `files`: the project files the version holds besides the apps file (empty for a version of a lone apps file). */
export type ConfigVersionResult = { ok: true; content: string; files: { path: string; project: string }[] } | { ok: false; message: string };

/** The text of one saved configuration version, secrets redacted by the agent. */
export async function configVersionAction(serverId: string, versionId: number): Promise<ConfigVersionResult> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { ok: false, message: "Unknown server." };
  if (!Number.isInteger(versionId) || versionId < 1) return { ok: false, message: "Unknown version." };
  try {
    const version = await agentFor(server).configVersion(versionId);
    return { ok: true, content: version.content, files: (version.files ?? []).map((f) => ({ path: f.path, project: f.project })) };
  } catch (err) {
    return { ok: false, message: err instanceof AgentError ? err.message : "unexpected error talking to the agent" };
  }
}
