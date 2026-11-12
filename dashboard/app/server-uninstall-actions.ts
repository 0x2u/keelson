"use server";

import { revalidatePath } from "next/cache";
import { AgentError, agentFor } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import { getCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";
import { previewUninstallOverSsh, SshInstallError, uninstallAgentOverSsh, type InstallStage } from "@/lib/ssh-install";
import { validateTarget, type UninstallReport } from "@/lib/ssh-install-core";
import { checkLogin, toSshTarget } from "@/lib/ssh-login";
import { currentlyBusy } from "@/lib/agent-busy";
import type { FieldErrors, InstallValues } from "@/app/server-install-actions";

export type UninstallPreview =
  | {
      ok: true;
      /** What a plain uninstall and a purge would each do. */
      keep: UninstallReport;
      purge: UninstallReport;
      /** What the agent is doing right now: stopping it would interrupt that. Empty when idle or unreachable. */
      busy: string[];
      agentReachable: boolean;
    }
  | { ok: false; message: string; stage?: InstallStage; errors?: FieldErrors };

export type UninstallResult =
  | {
      ok: true;
      report: UninstallReport;
      /** Something still answers at the agent's address after the uninstall. */
      stillAnswering: boolean;
    }
  | { ok: false; message: string; stage?: InstallStage; errors?: FieldErrors; busy?: string[] };

function describe(err: unknown): string {
  return err instanceof AgentError || err instanceof Error ? err.message : "unexpected error";
}

function checkInput(values: InstallValues, confirmedFingerprint: string): { errors?: FieldErrors; message?: string; host: string; port: number } {
  const errors: FieldErrors = {};
  const target = validateTarget({ host: values.host, port: values.port, username: values.username });
  Object.assign(errors, target.errors);
  checkLogin(values, errors);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(confirmedFingerprint)) return { message: "Confirm the server's host key first.", host: target.host, port: target.port };
  if (Object.keys(errors).length > 0) return { errors, message: "Check the highlighted fields.", host: target.host, port: target.port };
  return { host: target.host, port: target.port };
}

/**
 * Step three of an uninstall: logs in once and asks the server what removing the agent would do, with and without a purge,
 * without changing anything. The login is used for this call only.
 */
export async function previewUninstallAction(serverId: string, values: InstallValues, confirmedFingerprint: string): Promise<UninstallPreview> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { ok: false, message: "This server is not in the dashboard any more." };
  const input = checkInput(values, confirmedFingerprint);
  if (input.message) return { ok: false, message: input.message, errors: input.errors };

  let reports: { keep: UninstallReport; purge: UninstallReport };
  try {
    reports = await previewUninstallOverSsh(toSshTarget(values, input.host, input.port), confirmedFingerprint);
  } catch (err) {
    if (err instanceof SshInstallError) return { ok: false, message: err.message, stage: err.stage };
    return { ok: false, message: describe(err) };
  }
  const { reachable, busy } = await currentlyBusy(server);
  return { ok: true, ...reports, busy, agentReachable: reachable };
}

/**
 * Removes the agent from the server. Refused while the agent is deploying or running a job, unless `force`. The apps'
 * containers are never touched. The dashboard's own record of the server is left for the page to drop afterwards: dropping it
 * here would replace the page that is about to tell the operator what happened with a "not found".
 */
export async function uninstallAgentAction(
  serverId: string,
  values: InstallValues,
  confirmedFingerprint: string,
  opts: { purge: boolean; force: boolean; purgeOperatorFiles?: boolean },
): Promise<UninstallResult> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { ok: false, message: "This server is not in the dashboard any more." };
  const locked = await stepUpError(stepUp.servers("uninstall"), "uninstalling an agent");
  if (locked) return { ok: false, message: locked };
  const input = checkInput(values, confirmedFingerprint);
  if (input.message) return { ok: false, message: input.message, errors: input.errors };

  if (!opts.force) {
    const { busy } = await currentlyBusy(server);
    if (busy.length > 0) {
      return { ok: false, message: "The agent is busy: stopping it now would interrupt it. Wait for it to finish, or uninstall anyway.", busy };
    }
  }

  const { ip } = await clientInfo();
  let outcome;
  try {
    outcome = await uninstallAgentOverSsh(toSshTarget(values, input.host, input.port), confirmedFingerprint, opts.purge, undefined, opts.purgeOperatorFiles === true);
  } catch (err) {
    if (err instanceof SshInstallError) return { ok: false, message: err.message, stage: err.stage };
    return { ok: false, message: describe(err) };
  }
  const { report } = outcome;
  // The uninstaller refuses before removing anything when it cannot stop the agent: the agent is then still there.
  if (outcome.error && report.problems.length === 0) {
    return { ok: false, stage: "install", message: `The agent was not removed: ${outcome.error}` };
  }

  audit("agent_uninstalled", `${server.name}${opts.purge ? " (purged)" : ""}${report.problems.length > 0 ? `, ${report.problems.length} step(s) failed` : ""}`, ip);
  const stillAnswering = report.installed ? await agentFor(server).healthy() : false;
  revalidatePath("/", "layout");
  return { ok: true, report, stillAnswering };
}
