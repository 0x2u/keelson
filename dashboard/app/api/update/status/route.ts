import { NextResponse } from "next/server";
import { hasSession } from "@/lib/session";
import { updaterState } from "@/lib/updater";

export const dynamic = "force-dynamic";

/**
 * What the Update panel polls while an update runs: whether the one-click update is available, the version this dashboard runs,
 * the host's status of the run and whether a request still waits. Two small files are read; nothing is changed. It needs a
 * session, like every route that is not meant for machines (the proxy refuses the rest, this checks again).
 */
export async function GET() {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(updaterState(), { headers: { "Cache-Control": "no-store" } });
}
