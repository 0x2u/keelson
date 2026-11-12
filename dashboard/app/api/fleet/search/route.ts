import { NextResponse } from "next/server";
import { paletteIndex } from "@/lib/palette";
import { hasSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What the command palette searches, across all servers: bounded, cached for a few seconds, for the signed-in dashboard only. */
export async function GET() {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await paletteIndex(), { headers: { "Cache-Control": "no-store" } });
}
