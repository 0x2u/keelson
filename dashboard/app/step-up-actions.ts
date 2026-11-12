"use server";

import { requireSession } from "@/lib/session";
import { unlock, unlockedUntil, type UnlockResult } from "@/lib/step-up";

/** Unlocks sensitive changes for ten minutes: the password again, and the authenticator code when one is enrolled. */
export async function unlockAction(_prev: UnlockResult, form: FormData): Promise<UnlockResult> {
  // A session that may only set up a second factor (KEELSON_REQUIRE_2FA) has to be able to unlock too: adding the factor is what needs it.
  await requireSession({ allowSetupSession: true });
  return unlock(form);
}

/** Until when this session is unlocked, or null (for the padlock in the top bar). */
export async function unlockStatusAction(): Promise<{ until: number | null }> {
  await requireSession({ allowSetupSession: true });
  return { until: await unlockedUntil() };
}
