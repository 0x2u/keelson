"use server";

import QRCode from "qrcode";
import { revalidatePath } from "next/cache";
import {
  audit,
  beginTotpSetup,
  confirmTotp,
  deletePasskey,
  disableTotp,
  isLoginBlocked,
  pendingTotpSecret,
  recordLoginFailure,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  revokeSession,
  secondFactorEnrolled,
  TotpAlreadyEnabledError,
  totpEnabled,
} from "@/lib/auth/store";
import { otpauthUrl } from "@/lib/auth/totp";
import { confirmPassword } from "@/lib/auth/confirm";
import { clientInfo, currentSession, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { factorChange } from "@/lib/step-up-core";

/** The outcome of a security action: an error to show, or what to show after success. */
export interface SecurityState {
  error?: string;
  ok?: boolean;
  /** Shown once, never stored in clear: only after enrolling or regenerating. */
  recoveryCodes?: string[];
}

export interface TotpSetup {
  /** The secret, for typing into an authenticator by hand. */
  secret: string;
  /** A QR code of the otpauth URL, as a data URL. */
  qr: string;
}

async function record(event: string, detail?: string): Promise<void> {
  audit(event, detail, (await clientInfo()).ip);
}

/** Starts or restarts authenticator enrolment. Nothing is protected until a first code is confirmed. */
export async function startTotpSetupAction(): Promise<TotpSetup | { error: string }> {
  await requireSession({ allowSetupSession: true });
  // Adding a way to sign in is what a stolen session would do to stay: it needs the password and the code again.
  const locked = await stepUpError(factorChange("an authenticator app"), "starting authenticator setup");
  if (locked) return { error: locked };
  let secret: string;
  try {
    secret = beginTotpSetup();
  } catch (err) {
    if (err instanceof TotpAlreadyEnabledError) return { error: err.message };
    throw err;
  }
  const qr = await QRCode.toDataURL(otpauthUrl(secret, "operator", "Keelson"), { margin: 1, width: 224 });
  return { secret, qr };
}

/** The enrolment in progress, so a reload shows the same QR code instead of silently replacing the secret. */
export async function pendingTotpSetupAction(): Promise<TotpSetup | null> {
  await requireSession({ allowSetupSession: true });
  const secret = pendingTotpSecret();
  if (!secret) return null;
  return { secret, qr: await QRCode.toDataURL(otpauthUrl(secret, "operator", "Keelson"), { margin: 1, width: 224 }) };
}

export async function confirmTotpAction(_prev: SecurityState, form: FormData): Promise<SecurityState> {
  await requireSession({ allowSetupSession: true });
  const { ip } = await clientInfo();
  if (isLoginBlocked(ip)) return { error: "Too many failed attempts. Try again in a few minutes." };
  const code = form.get("code");
  const done = typeof code === "string" ? confirmTotp(code) : null;
  if (!done) {
    recordLoginFailure(ip);
    return { error: "That code is not valid. Check that your phone's clock is right and try the next code." };
  }
  await record("totp_enabled");
  revalidatePath("/settings/security");
  return { ok: true, recoveryCodes: done.recoveryCodes };
}

export async function disableTotpAction(_prev: SecurityState, form: FormData): Promise<SecurityState> {
  await requireSession();
  const error = await confirmPassword(form);
  if (error) return { error };
  if (!totpEnabled()) return { error: "The authenticator is not enabled." };
  disableTotp();
  await record("totp_disabled");
  revalidatePath("/settings/security");
  return { ok: true };
}

export async function regenerateRecoveryCodesAction(_prev: SecurityState, form: FormData): Promise<SecurityState> {
  await requireSession();
  const error = await confirmPassword(form);
  if (error) return { error };
  if (!secondFactorEnrolled()) return { error: "Enable an authenticator or a passkey first." };
  const recoveryCodes = regenerateRecoveryCodes();
  await record("recovery_codes_regenerated");
  revalidatePath("/settings/security");
  return { ok: true, recoveryCodes };
}

export async function deletePasskeyAction(id: string, _prev: SecurityState, form: FormData): Promise<SecurityState> {
  await requireSession();
  const error = await confirmPassword(form);
  if (error) return { error };
  if (!deletePasskey(id)) return { error: "That passkey no longer exists." };
  await record("passkey_removed", id.slice(0, 8));
  revalidatePath("/settings/security");
  return { ok: true };
}

export async function revokeSessionAction(id: string): Promise<void> {
  await requireSession();
  if (revokeSession(id)) await record("session_revoked", id.slice(0, 8));
  revalidatePath("/settings/security");
}

export async function revokeOtherSessionsAction(): Promise<void> {
  await requireSession();
  const keep = (await currentSession())?.id ?? null;
  const n = revokeOtherSessions(keep);
  await record("sessions_revoked", `${n} other session(s)`);
  revalidatePath("/settings/security");
}
