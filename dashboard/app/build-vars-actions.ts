"use server";

import { revalidatePath } from "next/cache";
import type { EnvIssue } from "@/lib/agent-types";
import { AgentError, agentFor } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import { changeIssues, type EnvEdit } from "@/lib/env-core";
import { getCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { variables } from "@/lib/step-up-core";

/** What an action says back: never a value. A success is counted (the names are on the page after the refresh). */
export type BuildVarsActionResult =
  | { ok: true; changed: number; removed: number }
  | { ok: false; error: string; issues: EnvIssue[] };

const fail = (
  error: string,
  issues: EnvIssue[] = [],
): BuildVarsActionResult => ({ ok: false, error, issues });

/** The names a line of the audit log lists: the log never holds a value. */
const names = (keys: string[]): string => keys.join(", ");

/**
 * Sets, replaces and removes build variables kept on `builderId` (the server that builds `app` for another one) in a single
 * request to its agent. The values come in with the call and go to that agent; they are not logged, audited, kept or returned.
 * The audit log names the variables. `appServerId` is the server the page belongs to, refreshed afterwards.
 */
export async function saveBuildVarsAction(
  appServerId: string,
  builderId: string,
  app: string,
  edits: { key: string; value: string }[],
  remove: string[] = [],
): Promise<BuildVarsActionResult> {
  await requireSession();
  const blocked = await stepUpError(variables(), "build variables");
  if (blocked) return fail(blocked);
  const builder = getCredentials(builderId);
  if (!builder) return fail("Unknown server.");
  if (
    !Array.isArray(edits) ||
    !Array.isArray(remove) ||
    edits.length + remove.length === 0
  )
    return fail("Nothing to save.");
  if (
    edits.some(
      (e) => typeof e?.key !== "string" || typeof e.value !== "string",
    ) ||
    remove.some((k) => typeof k !== "string")
  )
    return fail("Nothing to save.");
  const clean: EnvEdit[] = edits.map((e) => ({
    key: e.key,
    value: e.value,
    build: true,
  }));

  const agent = agentFor(builder);
  // The names already stored count toward the agent's limit; a failure to read them leaves the agent to check.
  let stored: string[] = [];
  try {
    stored = (await agent.buildVars(app))?.names.map((n) => n.name) ?? [];
  } catch {
    /* the agent will say */
  }
  const issues = changeIssues(clean, remove, stored);
  if (issues.length > 0) return fail("Some variables cannot be saved.", issues);

  const ip = (await clientInfo()).ip;
  const where = `${builder.name}: ${app} (build variables)`;
  const touched = [...clean.map((e) => e.key), ...remove];
  let result;
  try {
    result = await agent.setBuildVars(app, {
      set: Object.fromEntries(clean.map((e) => [e.key, e.value ?? ""])),
      remove,
    });
  } catch (err) {
    const error =
      err instanceof AgentError
        ? err.message
        : "unexpected error talking to the agent";
    audit("build_vars_failed", `${where}: ${names(touched)}: ${error}`, ip);
    return fail(error);
  }
  if (!result.ok) {
    audit(
      "build_vars_failed",
      `${where}: ${names(touched)}: ${result.message}`,
      ip,
    );
    return fail(result.message, result.issues);
  }
  if (result.changed.length > 0)
    audit("build_vars_set", `${where}: ${names(result.changed)}`, ip);
  if (result.removed.length > 0)
    audit("build_vars_unset", `${where}: ${names(result.removed)}`, ip);
  revalidatePath(`/servers/${appServerId}`, "layout");
  return {
    ok: true,
    changed: result.changed.length,
    removed: result.removed.length,
  };
}

/** Removes every build variable kept on `builderId` for `app`. The audit entry lists the names that were stored. */
export async function deleteBuildVarsAction(
  appServerId: string,
  builderId: string,
  app: string,
): Promise<BuildVarsActionResult> {
  await requireSession();
  const blocked = await stepUpError(variables(), "build variables");
  if (blocked) return fail(blocked);
  const builder = getCredentials(builderId);
  if (!builder) return fail("Unknown server.");
  const ip = (await clientInfo()).ip;
  const where = `${builder.name}: ${app} (build variables)`;
  let removed: string[];
  try {
    removed = await agentFor(builder).deleteBuildVars(app);
  } catch (err) {
    const error =
      err instanceof AgentError
        ? err.message
        : "unexpected error talking to the agent";
    audit("build_vars_failed", `${where}: ${error}`, ip);
    return fail(error);
  }
  audit("build_vars_delete", `${where}: ${names(removed)}`, ip);
  revalidatePath(`/servers/${appServerId}`, "layout");
  return { ok: true, changed: 0, removed: removed.length };
}
