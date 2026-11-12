"use server";

import { revalidatePath } from "next/cache";
import type { EnvIssue, EnvScope, EnvVar } from "@/lib/agent-types";
import { AgentError, agentFor } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import { changeIssues, toChange, type EnvEdit } from "@/lib/env-core";
import { getCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { variables } from "@/lib/step-up-core";

/**
 * What an action says back: never a value. A success is counted (the names are on the page after the refresh); a failure
 * carries the text the agent or the checks gave, with the problems by name.
 */
export type EnvActionResult = { ok: true; changed: number; removed: number } | { ok: false; error: string; issues: EnvIssue[] };

const fail = (error: string, issues: EnvIssue[] = []): EnvActionResult => ({ ok: false, error, issues });

function isScope(scope: unknown): scope is EnvScope {
  return scope === "app" || scope === "preview";
}

/** The names a line of the audit log lists: the log never holds a value. */
const names = (keys: string[]): string => keys.join(", ");

/**
 * Sets, replaces and removes managed variables of one scope in a single request to the agent. The values come in with the
 * call and go to the agent; they are not logged, audited, kept, or returned. The audit log names the keys.
 */
export async function saveEnvAction(serverId: string, app: string, scope: EnvScope, edits: EnvEdit[], unset: string[] = []): Promise<EnvActionResult> {
  await requireSession();
  const blocked = await stepUpError(variables(), "stored variables");
  if (blocked) return fail(blocked);
  const server = getCredentials(serverId);
  if (!server) return fail("Unknown server.");
  if (!isScope(scope)) return fail("Unknown scope.");
  if (!Array.isArray(edits) || !Array.isArray(unset)) return fail("Nothing to save.");
  if (edits.length === 0 && unset.length === 0) return fail("Nothing to save.");
  if (edits.some((e) => typeof e?.key !== "string" || (typeof e.value !== "string" && e.value !== null)) || unset.some((k) => typeof k !== "string")) return fail("Nothing to save.");
  const clean: EnvEdit[] = edits.map((e) => ({ key: e.key, value: e.value, build: e.build === true }));

  const agent = agentFor(server);
  // The names already stored count toward the agent's limit; a failure to read them leaves the agent to check.
  let stored: EnvVar[] = [];
  try {
    stored = (await agent.envVars(app, scope))?.vars ?? [];
  } catch {
    /* the agent will say */
  }
  const issues = changeIssues(clean, unset, stored.map((v) => v.key));
  if (issues.length > 0) return fail("Some variables cannot be saved.", issues);

  const ip = (await clientInfo()).ip;
  const where = `${server.name}: ${app} (${scope})`;
  let result;
  try {
    result = await agent.setEnv(app, toChange(scope, clean, unset, stored));
  } catch (err) {
    const error = err instanceof AgentError ? err.message : "unexpected error talking to the agent";
    audit("env_set_failed", `${where}: ${names([...clean.map((e) => e.key), ...unset])}: ${error}`, ip);
    return fail(error);
  }
  if (!result.ok) {
    audit("env_set_failed", `${where}: ${names([...clean.map((e) => e.key), ...unset])}: ${result.message}`, ip);
    return fail(result.message, result.issues);
  }
  if (result.changed.length > 0) {
    const builds = clean.filter((e) => e.build && result.changed.includes(e.key)).map((e) => e.key);
    audit("env_set", `${where}: ${names(result.changed)}${builds.length > 0 ? ` (build: ${names(builds)})` : ""}`, ip);
  }
  if (result.removed.length > 0) audit("env_unset", `${where}: ${names(result.removed)}`, ip);
  // A flag changed on a variable that was already stored is a change of its own, even when its value was left alone.
  const flagged = clean.flatMap((e) => {
    const before = stored.find((v) => v.key === e.key);
    return before !== undefined && before.build !== e.build ? [{ key: e.key, on: e.build }] : [];
  });
  if (flagged.length > 0) {
    const list = (on: boolean) => flagged.filter((f) => f.on === on).map((f) => f.key);
    const parts = [list(true).length > 0 ? `build on: ${names(list(true))}` : "", list(false).length > 0 ? `build off: ${names(list(false))}` : ""].filter((p) => p !== "");
    audit("env_build", `${where}: ${parts.join("; ")}`, ip);
  }
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true, changed: result.changed.length, removed: result.removed.length };
}

/** Removes every managed variable of one scope. The audit entry lists the names that were stored. */
export async function deleteEnvScopeAction(serverId: string, app: string, scope: EnvScope): Promise<EnvActionResult> {
  await requireSession();
  const blocked = await stepUpError(variables(), "stored variables");
  if (blocked) return fail(blocked);
  const server = getCredentials(serverId);
  if (!server) return fail("Unknown server.");
  if (!isScope(scope)) return fail("Unknown scope.");
  const agent = agentFor(server);
  const ip = (await clientInfo()).ip;
  const where = `${server.name}: ${app} (${scope})`;
  let keys: string[] = [];
  try {
    keys = ((await agent.envVars(app, scope))?.vars ?? []).map((v) => v.key);
    await agent.deleteEnv(app, scope);
  } catch (err) {
    const error = err instanceof AgentError ? err.message : "unexpected error talking to the agent";
    audit("env_delete_failed", `${where}: ${error}`, ip);
    return fail(error);
  }
  audit("env_delete", `${where}: ${names(keys)}`, ip);
  revalidatePath(`/servers/${serverId}`, "layout");
  return { ok: true, changed: 0, removed: keys.length };
}
