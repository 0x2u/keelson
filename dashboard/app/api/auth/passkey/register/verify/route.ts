import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/auth/store";
import { finishRegistration, passkeysAvailable } from "@/lib/auth/webauthn";
import { clientInfo, currentSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { factorChange } from "@/lib/step-up-core";

export const dynamic = "force-dynamic";

interface Body {
  response?: RegistrationResponseJSON;
  name?: string;
}

/** Step two: check what the authenticator produced and store the passkey. */
export async function POST(request: Request) {
  if (!(await currentSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A passkey signs in without the password and outlives a revoked session: a stolen session must not be able to add one.
  const locked = await stepUpError(factorChange("a passkey"), "registering a passkey");
  if (locked) return NextResponse.json({ error: locked }, { status: 403 });
  if (!passkeysAvailable()) return NextResponse.json({ error: "passkeys are not available" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.response || typeof body.response !== "object") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const ok = await finishRegistration(body.response, typeof body.name === "string" ? body.name : "");
  if (!ok) return NextResponse.json({ error: "The passkey could not be verified." }, { status: 400 });
  audit("passkey_added", undefined, (await clientInfo()).ip);
  return NextResponse.json({ ok: true });
}
