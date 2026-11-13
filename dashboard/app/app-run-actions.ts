"use server";

import { AgentError } from "@/lib/agent";
import type { AppConfig } from "@/lib/agent-types";
import { audit } from "@/lib/auth/store";
import { agentOf, change, failure } from "@/lib/config-change";
import { containerAction } from "@/app/container-actions";
import { getCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { findApp } from "@/lib/step-up-core";

export interface AppRunState {
  error?: string;
}

/**
 * What Stop and Start have in common: the app is read from the configuration as stored, `enabled` is set (false) or cleared,
 * and the app goes back through the same save every other app change uses (`saveApp`: the base hash of what was read,
 * the agent's validation, a config version of its own). Nothing is edited as text. Returns the message of a failure, null when
 * the stored configuration says what was asked afterwards (already so, or saved now).
 */
async function setEnabled(serverId: string, name: string, enabled: boolean): Promise<string | null> {
  const agent = await agentOf(serverId);
  if (!agent) return "Unknown server.";
  let doc;
  try {
    doc = await agent.config();
  } catch (err) {
    return failure(err).message;
  }
  if (doc === null) return "This agent has no apps file the dashboard can edit.";
  if (doc.error) return `The configuration file on the server is invalid: ${doc.error}`;
  const current = findApp(doc.model, name);
  if (!current) return `${name} is not in the apps file: it cannot be stopped or started from here.`;
  if ((current.enabled !== false) === enabled) return null;

  const next: AppConfig = { ...current };
  if (enabled) delete next.enabled;
  else next.enabled = false;
  const result = await change(serverId, (a) => a.saveApp(name, next, { base_hash: doc.hash, comment: enabled ? `Start ${name}` : `Stop ${name}` }));
  if (result.ok) return null;
  if (result.kind === "changed") return "The configuration was changed by someone else a moment ago. Reload the page and try again.";
  if (result.kind === "invalid") return result.message ?? result.issues.find((i) => i.severity === "error")?.message ?? "The agent refused the change.";
  return result.kind === "error" ? result.message : (result.message ?? "The agent cannot apply this change right now. Try again in a moment.");
}

/**
 * Stops an app and keeps it stopped: `enabled: false` in the apps file, which the agent applies by stopping the container.
 * Its configuration, image, variables, volumes, data and history stay; its domains answer 503. Only takes work away, so it
 * needs a session and not the unlock (like removing a job).
 */
export async function stopAppAction(serverId: string, app: string): Promise<AppRunState> {
  await requireSession();
  const ip = (await clientInfo()).ip;
  const where = `${getCredentials(serverId)?.name ?? serverId}: ${app}`;
  const error = await setEnabled(serverId, app, false);
  if (error !== null) {
    audit("app_stop_failed", `${where}: ${error}`, ip);
    return { error };
  }
  audit("app_stop", where, ip);
  return {};
}

/**
 * Starts a stopped app: clears `enabled` in the apps file, then starts its container (the agent starts nothing by itself).
 * The two steps are separate on purpose: when the second fails the first stays, and the message says what is left to do.
 * Running it again after that is safe: an app that is enabled already is not written again.
 */
export async function startAppAction(serverId: string, app: string): Promise<AppRunState> {
  await requireSession();
  const ip = (await clientInfo()).ip;
  const where = `${getCredentials(serverId)?.name ?? serverId}: ${app}`;
  const error = await setEnabled(serverId, app, true);
  if (error !== null) {
    audit("app_start_failed", `${where}: ${error}`, ip);
    return { error };
  }
  audit("app_start", where, ip);

  const agent = await agentOf(serverId);
  let container: string | undefined;
  try {
    const status = (await agent?.apps())?.find((a) => a.name === app);
    container = status?.container?.name.replace(/^\//, "");
  } catch (err) {
    return { error: `${app} is enabled again, but its container could not be looked up (${err instanceof AgentError ? err.message : "unexpected error talking to the agent"}). Start the container from its page.` };
  }
  if (!container) return { error: `${app} is enabled again, but it has no container to start. Deploy it to bring it up.` };
  const started = await containerAction(serverId, container, "start");
  if (started.error) return { error: `${app} is enabled again, but its container ${container} did not start: ${started.error}. Start it from the container's page, or press Start again.` };
  return {};
}
