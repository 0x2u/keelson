import "server-only";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { noFacts, ownerOfApp, ownerOfContainer, ownerOfDatabase, ownerOfJob, type OwnerFacts } from "@/lib/owner-core";
import type { ServerCredentials } from "@/lib/servers";

// The server side of lib/owner-core: reads what one server says (four small calls, in parallel) and asks the pure rules which
// project an entity of it belongs to. A page that already loaded some of these parts passes them in and they are not read twice.
// A part that cannot be read leaves the entity unowned: the page then keeps its server breadcrumb, which is never wrong.

/** What the page already read (null: the agent has none of it, e.g. a read-only agent's apps), so it is not read twice. */
export type KnownFacts = { [K in keyof OwnerFacts]?: OwnerFacts[K] | null };

export async function loadOwnerFacts(server: ServerCredentials, known: KnownFacts = {}): Promise<OwnerFacts> {
  const agent = agentFor(server);
  const [apps, jobs, databases, config] = await Promise.all([
    known.apps ?? load(agent.apps()).then((r) => r.data ?? null),
    known.jobs ?? load(agent.jobs()).then((r) => r.data ?? null),
    known.databases ?? load(agent.databases()).then((r) => r.data ?? null),
    known.config !== undefined ? known.config : load(agent.config()).then((r) => r.data?.model ?? null),
  ]);
  return { ...noFacts(), apps: apps ?? [], jobs: jobs ?? [], databases: databases ?? [], config };
}

/** The project an app belongs to (null for an unknown app, or a server that did not answer). */
export async function projectOfApp(server: ServerCredentials, app: string, known: KnownFacts = {}): Promise<string | null> {
  const apps = known.apps ?? (await load(agentFor(server).apps())).data ?? [];
  return ownerOfApp(apps, app);
}

export async function projectOfJob(server: ServerCredentials, job: string, known: KnownFacts = {}): Promise<string | null> {
  return ownerOfJob(await loadOwnerFacts(server, known), job);
}

export async function projectOfDatabase(server: ServerCredentials, database: string, known: KnownFacts = {}): Promise<string | null> {
  return ownerOfDatabase(await loadOwnerFacts(server, known), database);
}

export async function projectOfContainer(server: ServerCredentials, container: { name: string; appLabel?: string }, known: KnownFacts = {}): Promise<string | null> {
  if (container.appLabel) return projectOfApp(server, container.appLabel, known);
  return ownerOfContainer(await loadOwnerFacts(server, known), container);
}
