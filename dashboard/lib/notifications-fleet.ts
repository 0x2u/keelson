import "server-only";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { notificationsRow, testFact, type NotificationsRow, type ServerFacts } from "@/lib/notifications-fleet-core";
import { getNotificationsDefault } from "@/lib/notifications-default";
import type { NotificationsTemplate } from "@/lib/notifications-core";
import { mapPool } from "@/lib/pool";
import { getCredentials, listServers, type ServerSummary } from "@/lib/servers";

/** How many agents are asked at once: a fleet of a hundred must not open a hundred connections, nor wait for the slow ones one by one. */
const LOAD_CONCURRENCY = 20;

async function serverFacts(s: ServerSummary): Promise<ServerFacts> {
  const base = { id: s.id, name: s.name, canDeploy: s.canDeploy };
  const creds = getCredentials(s.id);
  if (!creds) return { ...base, config: { kind: "failed", reason: "this server is no longer registered" }, test: { kind: "unknown" } };
  if (creds.unreadable) return { ...base, config: { kind: "failed", reason: "its stored credentials cannot be read: the master key does not match" }, test: { kind: "unknown" } };
  const agent = agentFor(creds);
  const config = await load(agent.config());
  if (config.error !== undefined) return { ...base, config: { kind: "failed", reason: config.error }, test: { kind: "unknown" } };
  if (config.data === null) return { ...base, config: { kind: "no-file" }, test: { kind: "unknown" } };
  if (config.data.error) return { ...base, config: { kind: "invalid" }, test: { kind: "unknown" } };
  const proofs = await load(agent.proofs());
  const test = proofs.error === undefined ? testFact(proofs.data) : ({ kind: "unknown" } as const);
  return { ...base, config: { kind: "ok", hash: config.data.hash, notifications: config.data.model.notifications }, test };
}

export interface NotificationsFleet {
  rows: NotificationsRow[];
  /** The default, or null when none was set. */
  template: NotificationsTemplate | null;
  templateUpdatedAt: number | null;
}

/** Every server's notification settings as one row each, compared with the default. Started once per request by the page. */
export async function loadNotificationsFleet(): Promise<NotificationsFleet> {
  const stored = getNotificationsDefault();
  const template = stored?.template ?? null;
  const facts = await mapPool(listServers(), LOAD_CONCURRENCY, serverFacts);
  return { rows: facts.map((f) => notificationsRow(f, template)), template, templateUpdatedAt: stored?.updatedAt ?? null };
}
