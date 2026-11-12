"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminPasswordHash } from "@/lib/env";
import { PasswordBusyError, verifyPassword } from "@/lib/password";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";
import {
  PENDING_LOGIN_MAX_ATTEMPTS,
  audit,
  clearLoginFailures,
  isLoginBlocked,
  recordLoginFailure,
  recordSecondFactorFailure,
  recoveryCodesLeft,
  secondFactorEnrolled,
  secondFactorWaitMs,
  spendRecoveryCode,
  takePendingAttempt,
  verifyTotpLogin,
  type LoginMethod,
} from "@/lib/auth/store";
import { clientInfo, createSession, destroySession, finishPendingLogin, pendingLoginId, requireSession, startPendingLogin } from "@/lib/session";
import { AgentError, agentFor, probeAgent } from "@/lib/agent";
import {
  DuplicateServerError,
  createServer,
  deleteServer,
  getCredentials,
  updateServer,
} from "@/lib/servers";
import { normalizePublicIp } from "@/lib/address-core";
import { normalizeUrl, validateServer, type FieldErrors, type ServerFormValues } from "@/lib/server-input";
import type { RestoreRequest } from "@/lib/agent-types";
import { deployTargetOf } from "@/lib/deploy-target";

export interface LoginState {
  error?: string;
}

export interface ServerFormState {
  errors?: FieldErrors;
  /** A problem that belongs to no single field. */
  message?: string;
  /** What was typed, so the form can be re-shown; secrets are never echoed back. */
  values?: Pick<ServerFormValues, "name" | "url" | "caCert" | "clientCert" | "publicIp">;
}

export interface DeployState {
  error?: string;
  /** The deployment the agent started: the caller shows a toast linking to it and opens its log. */
  deploymentId?: string;
  /** The server that holds `deploymentId`, when it is not the one the action was about (the build server of an app built elsewhere). */
  serverId?: string;
}

const TOO_MANY = "Too many failed attempts. Try again in a few minutes.";
const BUSY = "The server is busy checking passwords. Try again in a moment.";

/**
 * Step one: the password. When a second factor is enrolled the login is not finished here: a
 * short-lived cookie records that the password was right, and the operator is sent to step two.
 * Failures at either step count against the same throttle, so a stolen password does not allow
 * unlimited guesses of the code.
 */
export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const { ip } = await clientInfo();
  if (isLoginBlocked(ip)) return { error: TOO_MANY };
  const password = form.get("password");
  // The hash is always computed, so a wrong password costs the same as a right one.
  let ok = false;
  if (typeof password === "string") {
    try {
      ok = await verifyPassword(password, adminPasswordHash());
    } catch (err) {
      if (err instanceof PasswordBusyError) return { error: BUSY };
      throw err;
    }
  }
  if (!ok) {
    recordLoginFailure(ip);
    audit("login_failed", "wrong password", ip);
    return { error: "Wrong password." };
  }
  if (secondFactorEnrolled()) {
    await startPendingLogin();
    redirect("/login/verify");
  }
  clearLoginFailures(ip);
  await createSession("password");
  redirect("/");
}

/**
 * Step two: an authenticator code, or one of the recovery codes. Three limits apply, and nothing between taking them and
 * looking at the code awaits anything, so requests sent together cannot slip past a check that has not seen the others:
 * the address's own failures (its IPv6 /64), a pause across all addresses once too many codes have failed in 15 minutes, and
 * the attempts of this one pending login (a counter in the database: the cookie cannot say how often it was used). A
 * pending login that has used its attempts is over: the password is asked for again.
 */
export async function verifySecondFactor(_prev: LoginState, form: FormData): Promise<LoginState> {
  const pid = await pendingLoginId();
  if (pid === null) redirect("/login");
  const { ip } = await clientInfo();
  if (isLoginBlocked(ip)) return { error: TOO_MANY };
  const wait = secondFactorWaitMs();
  if (wait > 0) return { error: `Too many wrong codes were entered. Try again in ${Math.ceil(wait / 1000)} seconds.` };
  const used = takePendingAttempt(pid);
  if (used === null) redirect("/login");

  const raw = form.get("code");
  const code = typeof raw === "string" ? raw : "";
  const digits = code.replace(/\s/g, "");
  let method: LoginMethod | null = null;
  if (/^\d{6}$/.test(digits)) {
    if (verifyTotpLogin(digits)) method = "password+totp";
  } else if (spendRecoveryCode(code)) {
    method = "password+recovery";
  }
  if (!method) {
    recordLoginFailure(ip);
    recordSecondFactorFailure();
    audit("login_failed", "second factor", ip);
    if (used >= PENDING_LOGIN_MAX_ATTEMPTS) {
      await finishPendingLogin(pid);
      audit("login_failed", "second factor: attempts used up, the password is asked for again", ip);
      // Not an error state of this form: the verify page ends with the sign-in it belongs to and sends the browser away before a
      // message could be seen, so the reason travels to the sign-in page.
      redirect("/login?reason=attempts");
    }
    return { error: "That code is not valid." };
  }
  await finishPendingLogin(pid);
  clearLoginFailures(ip);
  if (method === "password+recovery") audit("recovery_code_used", `${recoveryCodesLeft()} left`, ip);
  await createSession(method);
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function readServerForm(form: FormData): ServerFormValues {
  return {
    name: text(form, "name"),
    url: text(form, "url"),
    token: text(form, "token"),
    deploySecret: text(form, "deploySecret"),
    caCert: text(form, "caCert"),
    clientCert: text(form, "clientCert"),
    clientKey: text(form, "clientKey"),
    publicIp: text(form, "publicIp"),
  };
}

function echo(v: ServerFormValues): ServerFormState["values"] {
  return { name: v.name, url: v.url, caCert: v.caCert, clientCert: v.clientCert, publicIp: v.publicIp };
}

function describe(err: unknown): string {
  return err instanceof AgentError || err instanceof Error ? err.message : "unexpected error";
}

export async function createServerAction(_prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireSession();
  const values = readServerForm(form);
  const locked = await stepUpError(stepUp.servers("add"), "adding a server");
  if (locked) return { message: locked, values: echo(values) };
  const errors = validateServer(values, false);
  if (Object.keys(errors).length > 0) return { errors, values: echo(values) };

  // Refuse a server we cannot talk to: it would only fail later, less clearly.
  try {
    await probeAgent({
      url: normalizeUrl(values.url)!,
      token: values.token,
      deploySecret: values.deploySecret || null,
      caCert: values.caCert || null,
      clientCert: values.clientCert || null,
      clientKey: values.clientKey || null,
    });
  } catch (err) {
    return { message: `Could not connect: ${describe(err)}`, values: echo(values) };
  }

  let id: string;
  try {
    id = createServer({ ...values, publicIp: normalizePublicIp(values.publicIp ?? "") ?? undefined });
  } catch (err) {
    if (err instanceof DuplicateServerError) return { errors: { name: "Already used." }, values: echo(values) };
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/servers/${id}`);
}

export async function updateServerAction(id: string, _prev: ServerFormState, form: FormData): Promise<ServerFormState> {
  await requireSession();
  const current = getCredentials(id);
  if (!current) redirect("/");

  const values = readServerForm(form);
  const locked = await stepUpError(stepUp.servers("update"), "changing a server");
  if (locked) return { message: locked, values: echo(values) };
  const errors = validateServer(values, true);
  const removeDeploySecret = form.get("removeDeploySecret") === "on";
  if (values.clientCert !== "" && values.clientKey === "" && !current.hasClientKey) {
    errors.clientKey = "Client certificate and key go together.";
  }
  if (Object.keys(errors).length > 0) return { errors, values: echo(values) };

  try {
    await probeAgent({
      url: normalizeUrl(values.url)!,
      token: values.token || current.token,
      deploySecret: removeDeploySecret ? null : values.deploySecret || current.deploySecret,
      caCert: values.caCert || null,
      clientCert: values.clientCert || null,
      clientKey: values.clientCert ? values.clientKey || current.clientKey : null,
    });
  } catch (err) {
    return { message: `Could not connect: ${describe(err)}`, values: echo(values) };
  }

  try {
    updateServer(id, { ...values, publicIp: normalizePublicIp(values.publicIp ?? "") ?? "", removeDeploySecret });
  } catch (err) {
    if (err instanceof DuplicateServerError) return { errors: { name: "Already used." }, values: echo(values) };
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/servers/${id}`);
}

export async function deleteServerAction(id: string): Promise<{ error: string } | void> {
  await requireSession();
  const locked = await stepUpError(stepUp.servers("delete"), "removing a server");
  if (locked) return { error: locked };
  deleteServer(id);
  revalidatePath("/", "layout");
  redirect("/");
}

export async function deployAction(serverId: string, app: string, _prev: DeployState, form: FormData): Promise<DeployState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };

  const target = deployTargetOf(text(form, "ref"));
  if (!target) return { error: "Enter a tag (v1.2.3, a commit SHA) or a digest (sha256:...)." };

  let deploymentId: string;
  try {
    deploymentId = await agentFor(server).deploy(app, target);
  } catch (err) {
    return { error: describe(err) };
  }
  return { deploymentId };
}

export async function rollbackAction(serverId: string, app: string): Promise<DeployState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) redirect("/");
  let deploymentId: string;
  try {
    deploymentId = await agentFor(server).rollback(app);
  } catch (err) {
    return { error: describe(err) };
  }
  return { deploymentId };
}

export interface RunJobState {
  error?: string;
  /** The run that was started. */
  runId?: string;
}

export async function runJobAction(serverId: string, job: string): Promise<RunJobState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  try {
    const runId = await agentFor(server).runJob(job);
    revalidatePath(`/servers/${serverId}`, "layout");
    return { runId };
  } catch (err) {
    return { error: describe(err) };
  }
}

export interface RestoreDatabaseState {
  error?: string;
  /** The restore run that was started. */
  runId?: string;
}

/** Starts a restore. The age secret key travels in the request body only: it is neither stored nor returned. */
export async function restoreDatabaseAction(serverId: string, database: string, request: RestoreRequest): Promise<RestoreDatabaseState> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { error: "Unknown server." };
  if (request.overwrite) {
    const locked = await stepUpError(stepUp.liveRestore(), "restoring over the live database");
    if (locked) return { error: locked };
  }
  try {
    const runId = await agentFor(server).restoreDatabase(database, request);
    revalidatePath(`/servers/${serverId}`, "layout");
    return { runId };
  } catch (err) {
    return { error: describe(err) };
  }
}
