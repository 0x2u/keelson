import { NextResponse } from "next/server";
import { audit } from "@/lib/auth/store";
import { markRecoveryDownloaded, recoveryStepOf } from "@/lib/auth/setup";
import { dataDir } from "@/lib/db";
import { generatedMasterKeyHex, keySource } from "@/lib/env";
import { clientInfo, currentSession } from "@/lib/session";
import { RECOVERY_FILE_NAME, recoveryFileText } from "@/lib/setup-core";

export const dynamic = "force-dynamic";

/**
 * The recovery file with the generated master key. This is the only place the key is ever shown, and only to the session
 * that finished the setup, while its recovery step is open: once the operator closes the step, or when the key comes from
 * KEELSON_DASHBOARD_KEY (so the dashboard never held it for them), there is nothing to download. A POST, since it is recorded.
 */
export async function POST() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!recoveryStepOf(session.id) || keySource() !== "file") return NextResponse.json({ error: "There is no recovery file to download." }, { status: 404 });
  const body = recoveryFileText(generatedMasterKeyHex(), dataDir(), new Date());
  markRecoveryDownloaded(session.id);
  audit("recovery_file_downloaded", undefined, (await clientInfo()).ip);
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${RECOVERY_FILE_NAME}"`,
      "Cache-Control": "no-store",
    },
  });
}
