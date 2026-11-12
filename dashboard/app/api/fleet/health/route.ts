import { NextResponse } from "next/server";
import { fleetStatus } from "@/lib/fleet";
import { hasSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What the sidebar's status dots show: for each server, whether it answers and the attention model's verdict for it, and for each project its worst environment. */
export async function GET() {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await fleetStatus(), { headers: { "Cache-Control": "no-store" } });
}
