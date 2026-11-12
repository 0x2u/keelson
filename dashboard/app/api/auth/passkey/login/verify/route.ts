import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { audit, isLoginBlocked, recordLoginFailure, clearLoginFailures } from "@/lib/auth/store";
import { finishAuthentication, passkeysAvailable } from "@/lib/auth/webauthn";
import { clientInfo, createSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Body {
  response?: AuthenticationResponseJSON;
}

/** Public: proves possession of a passkey, with the user verified, and opens a session. */
export async function POST(request: Request) {
  const { ip } = await clientInfo();
  if (!passkeysAvailable()) return NextResponse.json({ error: "passkeys are not available" }, { status: 409 });
  if (isLoginBlocked(ip)) return NextResponse.json({ error: "Too many failed attempts. Try again in a few minutes." }, { status: 429 });
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.response || typeof body.response !== "object") return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (!(await finishAuthentication(body.response))) {
    recordLoginFailure(ip);
    audit("login_failed", "passkey", ip);
    return NextResponse.json({ error: "That passkey was not accepted." }, { status: 401 });
  }
  clearLoginFailures(ip);
  await createSession("passkey");
  return NextResponse.json({ ok: true });
}
