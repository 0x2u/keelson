import { NextResponse } from "next/server";
import { audit } from "@/lib/auth/store";
import { makeCopy, recordBackup } from "@/lib/dashboard-backup";
import { clientInfo, currentSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { dashboardCopy } from "@/lib/step-up-core";

export const dynamic = "force-dynamic";

/**
 * A copy of the dashboard's own database, as a download: a consistent SQLite file without the master key (an environment
 * variable, never in the file) and without sessions. A POST, since it records that a copy was taken; it needs an unlocked
 * session, as everything that can leave this machine with credentials in it.
 */
export async function POST() {
  if (!(await currentSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const locked = await stepUpError(dashboardCopy(), "downloading a copy of the dashboard's database");
  if (locked) return NextResponse.json({ error: locked }, { status: 403 });
  const copy = makeCopy();
  try {
    audit("dashboard_backup", `${copy.size} bytes`, (await clientInfo()).ip);
    recordBackup(Date.now());
  } catch (err) {
    copy.discard();
    throw err;
  }
  return new Response(copy.stream, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="${copy.name}"`,
      "Content-Length": String(copy.size),
      "Cache-Control": "no-store",
    },
  });
}
