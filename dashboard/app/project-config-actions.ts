"use server";

import type { ConfigIssue, ProjectSaveOptions, SplitPlan } from "@/lib/agent-types";
import { agentOf, change, failure, refreshConfigPages, type ConfigActionResult } from "@/lib/config-change";
import * as stepUp from "@/lib/step-up-core";
import type { ValidateResult } from "@/app/config-actions";

// The actions of a project's own configuration file (projects.d/<project>.yaml) on one server. They follow
// app/config-actions.ts: a session first, the step-up for what decides what the server runs, the agent's refusals
// (invalid, changed, needs_acknowledgement, busy) handed back as results. `base_hash` is the FILE's hash here.

/** Checks the file's text in the context of the whole configuration, without writing: every issue, with file and line. */
export async function validateProjectConfigAction(serverId: string, project: string, content: string): Promise<ValidateResult> {
  const agent = await agentOf(serverId);
  if (!agent) return { ok: false, issues: [], message: "Unknown server." };
  try {
    return await agent.validateProjectConfig(project, content);
  } catch (err) {
    return { ok: false, issues: [], message: failure(err).message };
  }
}

export async function saveProjectConfigAction(serverId: string, project: string, content: string, opts: ProjectSaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveProjectConfig(project, content, opts), {
    what: `configuration of project ${project}`,
    check: () => stepUp.rawDocument("editor"),
  });
}

/** Removes the project's file: its apps and jobs leave the configuration, which the agent asks to be acknowledged (`force`). */
export async function deleteProjectConfigAction(serverId: string, project: string, opts: ProjectSaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.deleteProjectConfig(project, opts), {
    what: `removing the configuration file of project ${project}`,
    check: () => stepUp.projectFileRemoval(project),
  });
}

/** What giving the project its own file would do (nothing is written), or why it cannot. `hash` is what the apply must be based on. */
export type SplitPlanResult = { ok: true; hash: string; plan: SplitPlan; issues: ConfigIssue[] } | { ok: false; message: string };

const SPLIT_REFUSED: Record<"invalid" | "changed" | "needs_acknowledgement" | "busy", string> = {
  invalid: "The agent cannot give this project its own file.",
  changed: "The configuration changed while the plan was made. Reload and try again.",
  needs_acknowledgement: "The agent asks for a confirmation that the plan does not expect. Reload and try again.",
  busy: "The agent cannot apply a configuration change right now. Try again in a moment.",
};

export async function planSplitAction(serverId: string, project: string): Promise<SplitPlanResult> {
  const agent = await agentOf(serverId);
  if (!agent) return { ok: false, message: "Unknown server." };
  try {
    const result = await agent.splitProject(project, { dry_run: true });
    if (result.ok) return { ok: true, hash: result.hash, plan: result.plan, issues: result.issues };
    return { ok: false, message: result.message ?? SPLIT_REFUSED[result.kind] };
  } catch (err) {
    return { ok: false, message: failure(err).message };
  }
}

/**
 * Moves the project's entities into its own file. `base_hash` is the hash the plan was made on: when the configuration
 * changed since, the agent answers "changed" and nothing moves, so what is written is what the plan showed.
 */
export async function splitProjectAction(serverId: string, project: string, opts: ProjectSaveOptions): Promise<ConfigActionResult> {
  const agent = await agentOf(serverId);
  if (!agent) return { ok: false, kind: "error", message: "Unknown server.", issues: [] };
  try {
    const result = await agent.splitProject(project, opts);
    if (!result.ok) return result;
    refreshConfigPages(serverId);
    return { ok: true, hash: result.fileHash ?? result.hash, config_hash: result.hash, version: result.version, issues: result.issues };
  } catch (err) {
    return failure(err);
  }
}
