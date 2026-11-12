import "server-only";
import { audit, clearLoginFailures, elevateSession, isLoginBlocked, recordLoginFailure, recordSecondFactorFailure, recoveryCodesLeft, secondFactorWaitMs, spendRecoveryCode, totpEnabled, verifyTotpLogin } from "@/lib/auth/store";
import { confirmPassword } from "@/lib/auth/confirm";
import { clientInfo, currentSession } from "@/lib/session";
import { STEP_UP_MESSAGE, type StepUp } from "@/lib/step-up-core";

/**
 * The message to show when this session may not do a sensitive thing yet, or null when it may: it has proved the password
 * and the authenticator code within the last ten minutes. Every demand is audited, with what asked for it.
 */
export async function stepUpError(verdict: StepUp, what: string): Promise<string | null> {
  if (!verdict.required) return null;
  const session = await currentSession();
  if (!session) return "Your session has ended. Sign in again.";
  if (session.elevatedUntil !== null && session.elevatedUntil > Date.now()) return null;
  audit("step_up_required", what, (await clientInfo()).ip);
  return `${verdict.reason} ${STEP_UP_MESSAGE}`;
}

export interface UnlockResult {
  error?: string;
  /** Until when this session may make sensitive changes, in milliseconds since the epoch. */
  until?: number;
}

/**
 * Proves the operator is there: the password again, and, when an authenticator is enrolled, a fresh code (or a recovery
 * code). Failures count against the sign-in throttle, like every other check of these secrets. On success the session is
 * elevated for ten minutes and the grant is audited.
 */
export async function unlock(form: FormData): Promise<UnlockResult> {
  const session = await currentSession();
  if (!session) return { error: "Your session has ended. Sign in again." };
  const { ip } = await clientInfo();
  if (isLoginBlocked(ip)) return { error: "Too many failed attempts. Try again in a few minutes." };

  const wrongPassword = await confirmPassword(form);
  if (wrongPassword) return { error: wrongPassword };

  if (totpEnabled()) {
    // Checked after the password (which awaits) and right before the code is looked at, as the sign-in does: see verifySecondFactor.
    const wait = secondFactorWaitMs();
    if (wait > 0) return { error: `Too many wrong codes were entered. Try again in ${Math.ceil(wait / 1000)} seconds.` };
    const raw = form.get("code");
    const code = typeof raw === "string" ? raw.trim() : "";
    const digits = code.replace(/\s/g, "");
    const ok = /^\d{6}$/.test(digits) ? verifyTotpLogin(digits) : code !== "" && spendRecoveryCode(code);
    if (!ok) {
      recordLoginFailure(ip);
      recordSecondFactorFailure();
      audit("step_up_failed", "second factor", ip);
      return { error: "That code is not valid." };
    }
    if (!/^\d{6}$/.test(digits)) audit("recovery_code_used", `${recoveryCodesLeft()} left`, ip);
  }
  clearLoginFailures(ip);
  const now = Date.now();
  if (!elevateSession(session.id, now)) return { error: "Your session has ended. Sign in again." };
  audit("step_up_granted", session.method, ip);
  return { until: now + 10 * 60 * 1000 };
}

/** Until when the session is unlocked, or null. */
export async function unlockedUntil(): Promise<number | null> {
  const session = await currentSession();
  return session?.elevatedUntil && session.elevatedUntil > Date.now() ? session.elevatedUntil : null;
}
