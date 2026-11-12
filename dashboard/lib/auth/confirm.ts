import "server-only";
import { audit, isLoginBlocked, recordLoginFailure } from "@/lib/auth/store";
import { adminPasswordHash } from "@/lib/env";
import { PasswordBusyError, verifyPassword } from "@/lib/password";
import { clientInfo } from "@/lib/session";

const PASSWORD_REQUIRED = "Enter your current password to confirm.";

/**
 * Changing how the account is protected, or who else can act for it, needs the password again, even inside a live
 * session: a stolen session alone must not be enough to remove a factor or mint a token. Failures count against the
 * login throttle. Returns the message to show, or null when the password was right.
 */
export async function confirmPassword(form: FormData): Promise<string | null> {
  const { ip } = await clientInfo();
  if (isLoginBlocked(ip)) return "Too many failed attempts. Try again in a few minutes.";
  const password = form.get("password");
  if (typeof password !== "string" || password === "") return PASSWORD_REQUIRED;
  let right: boolean;
  try {
    right = await verifyPassword(password, adminPasswordHash());
  } catch (err) {
    if (err instanceof PasswordBusyError) return "The server is busy checking passwords. Try again in a moment.";
    throw err;
  }
  if (!right) {
    recordLoginFailure(ip);
    audit("security_confirm_failed", "wrong password", ip);
    return "Wrong password.";
  }
  return null;
}
