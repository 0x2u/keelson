"use server";

import { revalidatePath } from "next/cache";
import { AgentError, agentFor, probeAgent } from "@/lib/agent";
import { DuplicateServerError, createServer, getCredentials, listServers, updateServer } from "@/lib/servers";
import { currentlyBusy } from "@/lib/agent-busy";
import { requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";
import { fetchHostFingerprint, installAgentOverSsh, RunTimedOut, SshInstallError, type InstallStage } from "@/lib/ssh-install";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { upgradeTimeoutOutcome } from "@/lib/ssh-upgrade-core";
import { checkLogin, toSshTarget } from "@/lib/ssh-login";
import { parseBundle, validateTarget, type AgentBundle } from "@/lib/ssh-install-core";

/** What the install form submits. Secrets (key, passphrase, passwords) are used for this one call and never stored. */
export interface InstallValues {
  host: string;
  port: string;
  username: string;
  authKind: "key" | "password";
  privateKey: string;
  passphrase: string;
  password: string;
  sudoPassword: string;
  /** How the server is called in the dashboard. */
  name: string;
  /** The port the agent will listen on. */
  agentPort: string;
  nginx: boolean;
  openFirewall: boolean;
}

export type FieldErrors = Partial<Record<keyof InstallValues, string>>;

export type FingerprintResult = { ok: true; fingerprint: string } | { ok: false; message: string; errors?: FieldErrors };

export type InstallResult =
  | { ok: true; serverId: string; notes: string[] }
  | { ok: false; message: string; stage?: InstallStage; errors?: FieldErrors; busy?: string[] };

const SERVER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u;

function describe(err: unknown): string {
  return err instanceof AgentError || err instanceof Error ? err.message : "unexpected error";
}

/** Step one: the server's SSH host key, read without logging in, for the operator to confirm. */
export async function hostFingerprintAction(host: string, port: string): Promise<FingerprintResult> {
  await requireSession();
  const target = validateTarget({ host, port, username: "root" });
  if (target.errors.host || target.errors.port) {
    return { ok: false, message: "Check the address.", errors: { host: target.errors.host, port: target.errors.port } };
  }
  try {
    return { ok: true, fingerprint: await fetchHostFingerprint(target.host, target.port) };
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
}

/**
 * Step two: log in with the confirmed host key, install the agent, and register the server. The credentials are only
 * held for the duration of this call.
 */
export async function installOverSshAction(values: InstallValues, confirmedFingerprint: string): Promise<InstallResult> {
  await requireSession();
  const locked = await stepUpError(stepUp.servers("install"), "installing an agent over SSH");
  if (locked) return { ok: false, message: locked };
  const errors: FieldErrors = {};
  const target = validateTarget({ host: values.host, port: values.port, username: values.username });
  Object.assign(errors, target.errors);
  const agentPort = Number(values.agentPort || "7443");
  if (!Number.isInteger(agentPort) || agentPort < 1024 || agentPort > 65535) errors.agentPort = "A port between 1024 and 65535.";
  const name = values.name.trim() || target.host;
  if (!SERVER_NAME.test(name)) errors.name = "Letters, digits, spaces, dots, dashes and underscores.";
  else if (listServers().some((s) => s.name === name)) errors.name = "A server with this name already exists.";
  checkLogin(values, errors);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(confirmedFingerprint)) return { ok: false, message: "Confirm the server's host key first." };
  if (Object.keys(errors).length > 0) return { ok: false, message: "Check the highlighted fields.", errors };

  const sshTarget = toSshTarget(values, target.host, target.port);

  let bundle: AgentBundle;
  try {
    bundle = await installAgentOverSsh(sshTarget, confirmedFingerprint, { name, listenPort: agentPort, nginx: values.nginx, openFirewall: values.openFirewall });
  } catch (err) {
    if (err instanceof SshInstallError) return { ok: false, message: err.message, stage: err.stage };
    return { ok: false, message: describe(err) };
  }
  return register(bundle, name);
}

/** The manual path: the operator ran the installer themselves and pastes what it printed. */
export async function importBundleAction(json: string, name: string): Promise<InstallResult> {
  await requireSession();
  const locked = await stepUpError(stepUp.servers("add"), "adding a server from a bundle");
  if (locked) return { ok: false, message: locked };
  let bundle: AgentBundle;
  try {
    bundle = parseBundle(json.trim());
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
  const label = name.trim() || bundle.name;
  if (!SERVER_NAME.test(label)) return { ok: false, message: "The name may hold letters, digits, spaces, dots, dashes and underscores.", errors: { name: "Not a valid name." } };
  return register(bundle, label);
}

/** Checks the agent answers over mutual TLS, then saves it with its credentials (encrypted at rest). */
async function register(bundle: AgentBundle, name: string): Promise<InstallResult> {
  const creds = { url: bundle.url, token: bundle.token, deploySecret: bundle.deploySecret, caCert: bundle.caCert, clientCert: bundle.clientCert, clientKey: bundle.clientKey };
  try {
    await probeAgent(creds);
  } catch (err) {
    return {
      ok: false,
      stage: "verify" as InstallStage,
      message: `The agent is installed but this dashboard cannot reach it: ${describe(err)}. Check that the agent's port is open to the dashboard's address, then run the install again: it is safe to repeat.`,
    };
  }
  let id: string;
  try {
    id = createServer({ name, ...creds });
  } catch (err) {
    if (err instanceof DuplicateServerError) return { ok: false, message: "A server with this name already exists.", errors: { name: "Already used." } };
    throw err;
  }
  revalidatePath("/", "layout");
  return { ok: true, serverId: id, notes: bundle.notes };
}

export type UpgradeResult = { ok: true; version: string } | { ok: false; message: string; stage?: InstallStage; errors?: FieldErrors; busy?: string[] };

/**
 * Replaces the agent on a server this dashboard already manages with the version it carries. The agent keeps its
 * address, secrets, apps and nginx setting (the installer remembers them); the dashboard stores the fresh client
 * certificate the installer issues. The SSH login is used for this call only.
 */
export async function upgradeAgentOverSshAction(serverId: string, values: InstallValues, confirmedFingerprint: string, opts: { force?: boolean } = {}): Promise<UpgradeResult> {
  await requireSession();
  const locked = await stepUpError(stepUp.servers("install"), "upgrading an agent over SSH");
  if (locked) return { ok: false, message: locked };
  const server = getCredentials(serverId);
  if (!server) return { ok: false, message: "This server is not in the dashboard any more." };
  const errors: FieldErrors = {};
  const target = validateTarget({ host: values.host, port: values.port, username: values.username });
  Object.assign(errors, target.errors);
  checkLogin(values, errors);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(confirmedFingerprint)) return { ok: false, message: "Confirm the server's host key first." };
  if (Object.keys(errors).length > 0) return { ok: false, message: "Check the highlighted fields.", errors };

  // Restarting the agent cancels a build or a backup and cuts a migration short (Prisma then refuses every later deployment
  // until it is resolved): wait for what is running, unless the operator says to go on.
  if (!opts.force) {
    const { busy } = await currentlyBusy(server);
    if (busy.length > 0) {
      return { ok: false, message: "The agent is busy: replacing it now would interrupt what it is running. Wait for it to finish, or update anyway.", busy };
    }
  }

  let bundle: AgentBundle;
  try {
    bundle = await installAgentOverSsh(toSshTarget(values, target.host, target.port), confirmedFingerprint, "upgrade");
  } catch (err) {
    if (err instanceof RunTimedOut) {
      // The command did not answer in time, which is not the same as having failed: look at the agent once more before saying so.
      // What it printed (the renewed client certificate) is lost, but the stored certificate stays valid for years.
      let running: string | null = null;
      try {
        running = (await agentFor(server).info()).version;
      } catch {
        // no answer: it may be restarting
      }
      const outcome = upgradeTimeoutOutcome(running, bundledAgentVersion());
      if (outcome.finished) {
        revalidatePath("/", "layout");
        return { ok: true, version: outcome.version };
      }
      return { ok: false, stage: "verify" as InstallStage, message: outcome.message };
    }
    if (err instanceof SshInstallError) return { ok: false, message: err.message, stage: err.stage };
    return { ok: false, message: describe(err) };
  }

  // The stored address stays: the operator may reach the agent by another name than the first one it was installed for.
  const renewed = { ...server, caCert: bundle.caCert, clientCert: bundle.clientCert, clientKey: bundle.clientKey };
  let version: string;
  try {
    version = (await agentFor(renewed).info()).version;
  } catch (err) {
    return {
      ok: false,
      stage: "verify" as InstallStage,
      message: `The agent was replaced but this dashboard cannot reach it: ${describe(err)}. Nothing was changed here; run the update again, it is safe to repeat.`,
    };
  }
  updateServer(serverId, { name: server.name, url: server.url, caCert: bundle.caCert, clientCert: bundle.clientCert, clientKey: bundle.clientKey });
  revalidatePath("/", "layout");
  return { ok: true, version };
}
