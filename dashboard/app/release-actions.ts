"use server";

import { checkReleaseNow } from "@/lib/release-check";
import type { ReleaseStatus } from "@/lib/release-check-core";
import { requireSession } from "@/lib/session";

// "Check now" of Settings > About: asks GitHub which release is the latest (at most once a minute, see lib/release-check.ts). It
// only reads a public page and changes nothing, so it needs a session and not the unlock.

export interface ReleaseCheckResult {
  enabled: boolean;
  status: ReleaseStatus;
  tag: string | null;
  failed: boolean;
  /** Asked less than a minute ago: the answer is the one already held. */
  limited: boolean;
}

export async function checkReleaseAction(): Promise<ReleaseCheckResult> {
  await requireSession();
  const { check, limited } = await checkReleaseNow();
  return { enabled: check.enabled, status: check.status, tag: check.latest?.tag ?? null, failed: check.failed, limited };
}
