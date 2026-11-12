import "server-only";
import { clientIpConfig, clientIpFrom } from "@/lib/client-ip";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit, createPendingLogin, createSessionRecord, endPendingLogin, liveSession, pendingLoginOpen, revokeSession, type LoginMethod, type SessionRecord } from "@/lib/auth/store";
import { recoveryStepOf } from "@/lib/auth/setup";
import { requireSecondFactor, secureCookies } from "@/lib/env";
import {
  PENDING_COOKIE,
  PENDING_SECONDS,
  SESSION_COOKIE,
  SESSION_SECONDS,
  sessionIdFromToken,
  signToken,
  verifyToken,
} from "@/lib/session-token";

export interface ClientInfo {
  /** "local" when the dashboard cannot tell clients apart (not behind a trusted proxy). */
  ip: string;
  userAgent?: string;
}

/** Who is calling: the address as lib/client-ip.ts reads it (a trusted proxy's header, never the client's own words). */
export async function clientInfo(): Promise<ClientInfo> {
  const h = await headers();
  return { ip: clientIpFrom(h, clientIpConfig()), userAgent: h.get("user-agent") ?? undefined };
}

async function setCookie(name: string, value: string, maxAge: number): Promise<void> {
  (await cookies()).set(name, value, { httpOnly: true, sameSite: "strict", secure: secureCookies(), path: "/", maxAge });
}

/** Opens a session: a row in the database (so it can be listed and revoked) and the cookie that names it. Returns the session's id. */
export async function createSession(method: LoginMethod): Promise<string> {
  const client = await clientInfo();
  const record = createSessionRecord({ ip: client.ip, userAgent: client.userAgent, method });
  await setCookie(SESSION_COOKIE, await signToken("session", { sid: record.id }, SESSION_SECONDS), SESSION_SECONDS);
  (await cookies()).delete(PENDING_COOKIE);
  audit("login", method, client.ip);
  return record.id;
}

/** Ends the current session everywhere it is known: the cookie and the database row. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const sid = await sessionIdFromToken(jar.get(SESSION_COOKIE)?.value);
  if (sid && revokeSession(sid)) audit("logout", undefined, (await clientInfo()).ip);
  jar.delete(SESSION_COOKIE);
  jar.delete(PENDING_COOKIE);
}

/** The live session of this request, or null: signed, not revoked, not expired, not idle for too long. */
export async function currentSession(): Promise<SessionRecord | null> {
  const sid = await sessionIdFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  return sid ? liveSession(sid) : null;
}

/**
 * With KEELSON_REQUIRE_2FA=true, a session opened with the password alone can do one thing: set up a
 * second factor. Everything else needs a session that went through one.
 */
function isSetupOnly(session: SessionRecord): boolean {
  return requireSecondFactor() && session.method === "password";
}

export async function hasSession(): Promise<boolean> {
  const session = await currentSession();
  return session !== null && !isSetupOnly(session);
}

/**
 * Guards pages, server actions and route handlers. The proxy also redirects,
 * but it only checks the signature: this checks the session is still alive.
 * `allowSetupSession` is for the pages and actions that enrol a second factor.
 * The session that finished the first-run setup can do nothing else until it has closed the recovery step.
 */
export async function requireSession(options: { allowSetupSession?: boolean } = {}): Promise<void> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (recoveryStepOf(session.id)) redirect("/setup/recovery");
  if (isSetupOnly(session) && !options.allowSetupSession) redirect("/settings/security?required=1");
}

/**
 * The password was right and a second factor is owed: remember it for a few minutes. The cookie names a row in the database
 * that counts the attempts (lib/auth/store.ts), so the cookie cannot be replayed for more tries than the row allows.
 */
export async function startPendingLogin(): Promise<void> {
  const pid = createPendingLogin(PENDING_SECONDS * 1000);
  await setCookie(PENDING_COOKIE, await signToken("pending", { pid }, PENDING_SECONDS), PENDING_SECONDS);
}

/** The id of the pending login this request holds: a signed cookie, whose row is still open. Null when there is none. */
export async function pendingLoginId(): Promise<string | null> {
  const payload = await verifyToken("pending", (await cookies()).get(PENDING_COOKIE)?.value);
  return payload !== null && typeof payload.pid === "string" && pendingLoginOpen(payload.pid) ? payload.pid : null;
}

export async function hasPendingLogin(): Promise<boolean> {
  return (await pendingLoginId()) !== null;
}

/** The pending login is over, because it was used or ran out of attempts: the cookie goes and the row with it. */
export async function finishPendingLogin(pid: string): Promise<void> {
  endPendingLogin(pid);
  (await cookies()).delete(PENDING_COOKIE);
}
