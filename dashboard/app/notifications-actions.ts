"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/auth/store";
import { applyTemplate, type ApplyOutcome, type ApplyResult, type ApplyTarget } from "@/lib/notifications-apply-core";
import { liveApplyDeps } from "@/lib/notifications-apply";
import { parseTemplate, webhookUrlProblem, type NotificationsTemplate, type TemplateErrors } from "@/lib/notifications-core";
import { getNotificationsDefault, setNotificationsDefault } from "@/lib/notifications-default";
import { clientInfo, requireSession } from "@/lib/session";

// The two writes of the notifications page that are not one server's form. Saving the default only writes a row of non-secret
// text in this dashboard. Applying it is a batch of ordinary saves, each through its agent's signed API (see lib/notifications-apply).

export type SaveDefaultResult = { ok: true; template: NotificationsTemplate; updatedAt: number } | { ok: false; errors: TemplateErrors };

/** Saves the default. Nothing is sent to any server. */
export async function saveNotificationsDefaultAction(raw: unknown): Promise<SaveDefaultResult> {
  await requireSession();
  const parsed = parseTemplate(raw);
  if (!parsed.ok) return parsed;
  const updatedAt = Date.now();
  setNotificationsDefault(parsed.template, updatedAt);
  audit("notifications_default_saved", undefined, (await clientInfo()).ip);
  revalidatePath("/settings/notifications");
  return { ok: true, template: parsed.template, updatedAt };
}

/** The most servers one request applies to: far above any fleet, small enough to refuse a request that is not one. */
const MAX_TARGETS = 500;

function targetsOf(raw: unknown): ApplyTarget[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TARGETS) return null;
  const targets: ApplyTarget[] = [];
  for (const t of raw) {
    if (typeof t !== "object" || t === null || typeof (t as ApplyTarget).id !== "string" || typeof (t as ApplyTarget).baseHash !== "string") return null;
    targets.push({ id: (t as ApplyTarget).id, baseHash: (t as ApplyTarget).baseHash });
  }
  return new Set(targets.map((t) => t.id)).size === targets.length ? targets : null;
}

const COUNTED: ApplyOutcome["status"][] = ["applied", "unchanged", "conflict", "refused", "needs-url", "read-only", "unreachable"];

/** A line of counts for the audit trail: how many of each, never which URL or what the agents said. */
function summary(results: { outcome: ApplyOutcome }[]): string {
  const parts = COUNTED.map((s) => [s, results.filter((r) => r.outcome.status === s).length] as const).filter(([, n]) => n > 0);
  return `${parts.map(([s, n]) => `${n} ${s}`).join(", ")} of ${results.length}`;
}

/**
 * Applies the saved default to the chosen servers, one signed save each, and says what became of every one. `urls` has one entry
 * per webhook slot of the default ("" keeps what each server stores): they are held for this request, sent to the agents and
 * nowhere else, and are in no result, no audit entry and no error. The session must be unlocked once for the batch when it
 * changes where alerts go; nothing is written when it is not.
 */
export async function applyNotificationsDefaultAction(rawTargets: unknown, rawUrls: unknown): Promise<ApplyResult> {
  await requireSession();
  const stored = getNotificationsDefault();
  if (stored === null) return { ok: false, message: "There is no default to apply. Set one first." };
  const targets = targetsOf(rawTargets);
  if (targets === null) return { ok: false, message: "Choose the servers to apply the default to." };
  const urls = Array.isArray(rawUrls) && rawUrls.every((u) => typeof u === "string") ? (rawUrls as string[]) : null;
  if (urls === null || urls.length !== stored.template.webhooks.length) return { ok: false, message: "The default has changed: reload the page and apply again." };
  const bad = urls.map((u) => webhookUrlProblem(u)).find((p) => p !== undefined);
  if (bad !== undefined) return { ok: false, message: bad };

  const result = await applyTemplate(targets, stored.template, urls, liveApplyDeps());
  if (result.ok) {
    audit("notifications_default_applied", summary(result.results), (await clientInfo()).ip);
    revalidatePath("/settings/notifications");
  }
  return result;
}
