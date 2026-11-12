import "server-only";
import type { AgentClient } from "@/lib/agent";
import type { AlertRecord } from "@/lib/agent-types";

// The notifications an agent raised, for the attention model's delivery rule. The fleet is read every ten seconds by the
// sidebar, and an alert's delivery changes rarely, so each server is asked at most once a minute (a failed read is
// remembered too: it is not asked again for a minute, and the rule then says nothing rather than something made up).
const TTL_MS = 60_000;

interface Entry {
  at: number;
  value: Promise<AlertRecord[] | null | undefined>;
}

const cache = new Map<string, Entry>();

/** The server's latest notifications; null for an agent that keeps none, undefined when it could not be read. */
export function recentAlerts(serverId: string, agent: AgentClient, now: number = Date.now()): Promise<AlertRecord[] | null | undefined> {
  const hit = cache.get(serverId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = agent.notificationHistory(200).catch(() => undefined);
  cache.set(serverId, { at: now, value });
  return value;
}
