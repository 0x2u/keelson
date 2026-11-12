import type { ConfigIssue, NotificationsConfig, SaveResult } from "@/lib/agent-types";
import { mergeTemplate, wouldChange, type NotificationsTemplate } from "@/lib/notifications-core";
import { mapPool } from "@/lib/pool";
import { notificationsChange } from "@/lib/step-up-core";

// Applying the default to many servers: read each one, work out its section, ask for the unlock once, save server by server.
// One server failing never stops the others. The agent decides (it validates, versions and refuses a stale base); this only
// reports what it said. Every webhook URL that travels here goes to the agents and nowhere else: results carry no config, and
// any text that came back is scrubbed of them.

/** One server to apply to, with the hash of the file as the operator saw it: a save on a file that moved since is refused, never forced. */
export interface ApplyTarget {
  id: string;
  baseHash: string;
}

/** What reading one server found. */
export type LoadedTarget = { kind: "ok"; notifications?: NotificationsConfig } | { kind: "read-only"; reason: string } | { kind: "unreachable"; reason: string };

/** A save: the agent's answer, or why it could not be asked. */
export type SaveAttempt = SaveResult | { ok: false; kind: "unreachable"; message: string } | { ok: false; kind: "error"; message: string };

export interface ApplyDeps {
  load(id: string): Promise<LoadedTarget>;
  save(id: string, config: NotificationsConfig, baseHash: string): Promise<SaveAttempt>;
  /** The step-up check, asked once for the whole batch: null when the session may go on, the message to show when it may not. */
  unlock(reason: string): Promise<string | null>;
}

export type ApplyOutcome =
  | { status: "applied"; version?: number; warnings: ConfigIssue[] }
  | { status: "unchanged" }
  /** The file moved since the operator looked: reported, not forced. */
  | { status: "conflict" }
  | { status: "refused"; kind: "invalid" | "needs_acknowledgement" | "busy" | "error"; message?: string; issues: ConfigIssue[] }
  | { status: "needs-url"; slot: number }
  | { status: "read-only"; reason: string }
  | { status: "unreachable"; reason: string };

export type ApplyResult = { ok: true; results: { id: string; outcome: ApplyOutcome }[] } | { ok: false; message: string };

/** How many servers are read, and written, at once. */
export const APPLY_CONCURRENCY = 4;

/** `text` with every secret taken out: a message from the agent or the network may echo what was sent. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s !== "") out = out.split(s).join("[redacted]");
  return out;
}

const scrubIssues = (issues: ConfigIssue[], secrets: readonly string[]): ConfigIssue[] => issues.map((i) => ({ ...i, message: scrubSecrets(i.message, secrets) }));

type Prepared = { done: ApplyOutcome } | { config: NotificationsConfig; sensitive: string | null; baseHash: string };

export async function applyTemplate(targets: readonly ApplyTarget[], template: NotificationsTemplate, urls: readonly string[], deps: ApplyDeps): Promise<ApplyResult> {
  const secrets = urls.map((u) => u.trim()).filter((u) => u !== "");

  const prepared = await mapPool(targets, APPLY_CONCURRENCY, async (t): Promise<Prepared> => {
    const loaded = await deps.load(t.id);
    if (loaded.kind === "read-only") return { done: { status: "read-only", reason: loaded.reason } };
    if (loaded.kind === "unreachable") return { done: { status: "unreachable", reason: loaded.reason } };
    if (!wouldChange(template, loaded.notifications, urls)) return { done: { status: "unchanged" } };
    const merged = mergeTemplate(loaded.notifications, template, urls);
    if (!merged.ok) return { done: { status: "needs-url", slot: merged.needsUrl } };
    const verdict = notificationsChange(loaded.notifications, merged.config);
    return { config: merged.config, sensitive: verdict.required ? verdict.reason : null, baseHash: t.baseHash };
  });

  // The unlock is asked before anything is written, and once: a batch that cannot go on writes nothing.
  const reason = prepared.map((p) => ("sensitive" in p ? p.sensitive : null)).find((r) => r !== null);
  if (reason !== undefined && reason !== null) {
    const blocked = await deps.unlock(reason);
    if (blocked !== null) return { ok: false, message: blocked };
  }

  const results = await mapPool(targets, APPLY_CONCURRENCY, async (t, i): Promise<{ id: string; outcome: ApplyOutcome }> => {
    const p = prepared[i];
    if ("done" in p) return { id: t.id, outcome: p.done };
    const answer = await deps.save(t.id, p.config, p.baseHash);
    return { id: t.id, outcome: outcomeOf(answer, secrets) };
  });
  return { ok: true, results };
}

function outcomeOf(answer: SaveAttempt, secrets: readonly string[]): ApplyOutcome {
  if (answer.ok) return { status: "applied", ...(answer.version === undefined ? {} : { version: answer.version }), warnings: scrubIssues(answer.issues, secrets) };
  if (answer.kind === "changed") return { status: "conflict" };
  if (answer.kind === "unreachable") return { status: "unreachable", reason: scrubSecrets(answer.message, secrets) };
  const message = answer.message === undefined ? undefined : scrubSecrets(answer.message, secrets);
  return { status: "refused", kind: answer.kind, ...(message === undefined ? {} : { message }), issues: "issues" in answer ? scrubIssues(answer.issues, secrets) : [] };
}
