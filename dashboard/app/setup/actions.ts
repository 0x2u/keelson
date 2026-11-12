"use server";

import { redirect } from "next/navigation";
import { audit, clearLoginFailures, isLoginBlocked, recordLoginFailure } from "@/lib/auth/store";
import { closeRecoveryStep, completeSetup, openRecoveryStep, recoveryStepOf, setupThrottleKey, setupTokenValid } from "@/lib/auth/setup";
import { keySource, setupRequired } from "@/lib/env";
import { hashPassword } from "@/lib/password";
import { clientInfo, createSession, currentSession } from "@/lib/session";
import { setupErrors, type SetupErrors } from "@/lib/setup-core";

export interface SetupState {
  /** A problem that belongs to no single field. */
  error?: string;
  errors?: SetupErrors;
}

export interface RecoveryState {
  error?: string;
}

const TOO_MANY = "Too many wrong tokens. Try again in a few minutes.";
const DONE = "This dashboard is already set up. Sign in instead.";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * First-run setup: the one-time token from the container log, and the admin password. Refused for good once a password
 * exists (set here, or in KEELSON_ADMIN_PASSWORD_HASH), whatever token is sent. A wrong token counts against its own
 * throttle key (the login's counters are not touched). On success the password is stored, the token is spent, the first
 * session is opened and the browser goes on to the recovery step.
 */
export async function completeSetupAction(_prev: SetupState, form: FormData): Promise<SetupState> {
  if (!setupRequired()) return { error: DONE };
  const { ip } = await clientInfo();
  const throttle = setupThrottleKey(ip);
  if (isLoginBlocked(throttle)) return { error: TOO_MANY };

  const fields = { token: text(form, "token").trim(), password: text(form, "password"), confirm: text(form, "confirm") };
  const errors = setupErrors(fields);
  if (!errors.token && !setupTokenValid(fields.token)) {
    errors.token = "That token is not valid. It is printed in the container log each time the dashboard starts: use the last one";
    recordLoginFailure(throttle);
    audit("setup_failed", "wrong or expired token", ip);
  }
  if (Object.keys(errors).length > 0) return { errors };

  // The token is spent in the same transaction that stores the password: a second request with it finds nothing.
  const outcome = completeSetup(fields.token, hashPassword(fields.password));
  if (outcome === "exists") return { error: DONE };
  if (outcome === "token") {
    recordLoginFailure(throttle);
    audit("setup_failed", "wrong or expired token", ip);
    return { errors: { token: "That token was just used or has expired. Restart the dashboard for a new one" } };
  }
  clearLoginFailures(throttle);
  audit("setup_completed", undefined, ip);
  openRecoveryStep(await createSession("password"));
  redirect("/setup/recovery");
}

/**
 * Closes the recovery step: the operator says they saved the key. When the key is the generated one, the file must have been
 * downloaded first (it is the only way the key is ever shown). Afterwards the key is never offered again.
 */
export async function finishRecoveryAction(_prev: RecoveryState, form: FormData): Promise<RecoveryState> {
  const session = await currentSession();
  if (!session) redirect("/login");
  const step = recoveryStepOf(session.id);
  if (!step) redirect("/");
  if (keySource() === "file" && !step.downloaded) return { error: "Download the recovery file first." };
  if (form.get("saved") !== "on") return { error: "Confirm that you saved it." };
  closeRecoveryStep(session.id);
  redirect("/setup/secure");
}
