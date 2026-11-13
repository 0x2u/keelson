"use server";

import { audit } from "@/lib/auth/store";
import { updateCheckEnabled } from "@/lib/env";
import { dashboardVersion } from "@/lib/agent-binaries";
import { releaseCheck } from "@/lib/release-check";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { dashboardUpdate } from "@/lib/step-up-core";
import { updaterState, writeUpdateRequest } from "@/lib/updater";
import { checkRequest } from "@/lib/updater-core";

// "Update to vX.Y.Z" of Settings > About. The dashboard writes a request file into the directory it shares with the host and
// the host's updater does the rest (lib/updater-core.ts). It replaces the code that holds every server's credentials, so it needs
// the unlock like the other dangerous actions.

export type RequestUpdateResult = { ok: true; version: string; requestedAt: number } | { ok: false; error: string };

export async function requestUpdateAction(version: string): Promise<RequestUpdateResult> {
  await requireSession();
  const locked = await stepUpError(dashboardUpdate(String(version)), `updating the dashboard to ${String(version)}`);
  if (locked) return { ok: false, error: locked };
  if (!updateCheckEnabled()) return { ok: false, error: "The update check is off: this dashboard does not look for releases, so it does not update itself." };
  // The version must be the latest release this dashboard itself knows (the cached check, which asks GitHub at most once a day):
  // a browser cannot name a version of its own choosing, and an old tab cannot ask for a release that has since been superseded.
  const { latest } = await releaseCheck();
  const now = new Date();
  const verdict = checkRequest({ version, running: dashboardVersion(), latest: latest?.tag ?? null, payload: updaterState(now.getTime()), now: now.getTime() });
  if (!verdict.ok) return verdict;
  try {
    writeUpdateRequest(verdict.version, now);
  } catch {
    return { ok: false, error: "Could not write the update request: the folder shared with the host is not writable. Re-run the install command on the host." };
  }
  audit("dashboard_update_requested", `${dashboardVersion()} -> ${verdict.version}`, (await clientInfo()).ip);
  return { ok: true, version: verdict.version, requestedAt: now.getTime() };
}
