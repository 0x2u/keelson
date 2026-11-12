import { NextResponse } from "next/server";
import { listPasskeys } from "@/lib/auth/store";
import { authenticationOptions, passkeysAvailable } from "@/lib/auth/webauthn";

export const dynamic = "force-dynamic";

/** Public: a sign-in with a passkey starts before there is a session. */
export async function POST() {
  if (!passkeysAvailable() || listPasskeys().length === 0) {
    return NextResponse.json({ error: "no passkey is registered" }, { status: 404 });
  }
  return NextResponse.json(await authenticationOptions());
}
