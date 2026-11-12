import { NextResponse } from "next/server";
import { passkeysAvailable, registrationOptions } from "@/lib/auth/webauthn";
import { currentSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { factorChange } from "@/lib/step-up-core";

export const dynamic = "force-dynamic";

/** Step one of adding a passkey: the challenge the browser's authenticator signs. */
export async function POST() {
  if (!(await currentSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A passkey signs in without the password and outlives a revoked session: a stolen session must not be able to add one.
  const locked = await stepUpError(factorChange("a passkey"), "registering a passkey");
  if (locked) return NextResponse.json({ error: locked }, { status: 403 });
  if (!passkeysAvailable()) return NextResponse.json({ error: "passkeys need KEELSON_PUBLIC_URL set to the dashboard's https address" }, { status: 409 });
  return NextResponse.json(await registrationOptions());
}
