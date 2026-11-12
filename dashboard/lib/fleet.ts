import "server-only";
import { agentFor, type AgentClient } from "@/lib/agent";
import { recentAlerts } from "@/lib/alert-history";
import type { Deployment, JobStatus } from "@/lib/agent-types";
import { attentionItems, snapshotFrom, summarize, type ServerSnapshot } from "@/lib/attention-core";
import { load } from "@/lib/data";
import { projectDots, type ProjectDotStatus } from "@/lib/project-dot-core";
import type { Tone } from "@/lib/status";
import { runTargets } from "@/lib/machine-core";
import { relayStatus } from "@/lib/relay";
import { getCredentials, lastSeen, listServers, markSeen, type ServerSummary } from "@/lib/servers";

/** Where a thing lives. */
export interface ServerRef {
  id: string;
  name: string;
}

export interface ServerHealth extends ServerRef {
  reachable: boolean;
  /** Why the agent did not answer. */
  reason?: string;
}

/** A server whose data is missing from a fleet view, and why: the view says so instead of showing an empty list. */
export interface ServerFailure extends ServerRef {
  reason: string;
}

export interface FleetJob {
  server: ServerRef;
  job: JobStatus;
}

export async function serverHealth(): Promise<ServerHealth[]> {
  return Promise.all(
    listServers().map(async (s) => {
      const creds = getCredentials(s.id);
      const info = creds ? await load(agentFor(creds).info()) : { error: "this server is no longer registered" };
      const reachable = info.error === undefined;
      if (reachable) markSeen(s.id);
      return { id: s.id, name: s.name, reachable, ...(info.error === undefined ? {} : { reason: info.error }) };
    }),
  );
}

/** Everything one server says, for the home page and the sidebar: the attention model's input, plus what the page shows. */
export interface FleetServer extends ServerSnapshot {
  url: string;
  transport: ServerSummary["transport"];
  serves: boolean;
  canDeploy: boolean;
  version?: string;
  readOnly?: boolean;
  deployments?: Deployment[];
}

/** When the server last answered: a server that connects out says it itself, the others are as the last probe found them. */
const seenAt = (s: Pick<ServerSummary, "id" | "transport">): number | null => (s.transport === "relay" ? (relayStatus(s.id).lastSeen ?? lastSeen(s.id)) : lastSeen(s.id));

async function loadServerState(s: Pick<ServerSummary, "id" | "name" | "url" | "transport" | "serves" | "canDeploy">): Promise<FleetServer> {
  const creds = getCredentials(s.id);
  const server = { id: s.id, name: s.name };
  const kind = { url: s.url, transport: s.transport, serves: s.serves, canDeploy: s.canDeploy };
  if (!creds) return { server, ...kind, reachable: false, reason: "this server is no longer registered", lastSeen: lastSeen(s.id) };
  if (creds.unreadable) {
    return { server, ...kind, reachable: false, reason: "its stored credentials cannot be read: the master key does not match the one they were saved with (remove the server and add it again)", lastSeen: lastSeen(s.id) };
  }
  const agent = agentFor(creds);
  const [info, system, containers, apps, jobs, databases, proxy, deployments, alerts] = await Promise.all([
    load(agent.info()),
    load(agent.system()),
    load(agent.containers(true)),
    load(agent.apps()),
    load(agent.jobs()),
    load(agent.databases()),
    load(agent.proxy()),
    load(agent.deployments(undefined, 30)),
    recentAlerts(s.id, agent),
  ]);
  if (info.error === undefined) markSeen(s.id);
  const snapshot = snapshotFrom(server, { info, system, containers, apps, jobs, databases, proxy }, info.error === undefined ? Date.now() : seenAt(s));
  return {
    ...snapshot,
    ...(info.error === undefined && alerts !== undefined ? { alerts } : {}),
    ...kind,
    ...(info.error === undefined ? { version: info.data.version, readOnly: info.data.read_only, deployments: deployments.data } : {}),
  };
}

/** Every server's state, loaded at once; a server that does not answer is there, marked unreachable, with the reason. */
export async function loadFleet(): Promise<FleetServer[]> {
  return Promise.all(listServers().map(loadServerState));
}

/**
 * The state of the servers that run things. A build machine that connects out is left out of what judges the fleet (home,
 * the sidebar's dots, databases): a laptop that is closed is not an incident.
 */
export async function loadRunningFleet(): Promise<FleetServer[]> {
  return runTargets(await loadFleet());
}

/** What the sidebar shows next to each server (reachable or not) and each project: the attention model's verdict, the worst environment. */
export async function fleetStatus(now: number = Date.now()): Promise<{ servers: { id: string; name: string; reachable: boolean; tone: Tone; label: string; count: number }[]; projects: ProjectDotStatus[] }> {
  const fleet = await loadRunningFleet();
  const items = attentionItems(fleet, now);
  const servers = fleet.map((f) => {
    const mine = items.filter((i) => i.server.id === f.server.id);
    const summary = summarize(mine);
    return { id: f.server.id, name: f.server.name, reachable: f.reachable, tone: f.reachable || mine.length === 0 ? summary.tone : ("danger" as Tone), label: summary.label, count: summary.count };
  });
  return { servers, projects: projectDots(fleet) };
}

type Failed = { failed: ServerFailure[] };

/** Runs `fn` against every server at once, keeping what each returned and which servers failed (and why). */
async function perServerDetailed<T>(fn: (server: ServerRef, agent: AgentClient) => Promise<T[] | null>): Promise<{ items: T[] } & Failed> {
  const results = await Promise.all(
    listServers().map(async (s) => {
      const ref = { id: s.id, name: s.name };
      const creds = getCredentials(s.id);
      if (!creds) return { items: [] as T[], failure: { ...ref, reason: "this server is no longer registered" } };
      const out = await load(fn(ref, agentFor(creds)));
      if (out.error !== undefined) return { items: [] as T[], failure: { ...ref, reason: out.error } };
      return { items: out.data ?? [] };
    }),
  );
  return { items: results.flatMap((r) => r.items), failed: results.flatMap((r) => ("failure" in r && r.failure ? [r.failure] : [])) };
}

export async function fleetJobs(): Promise<{ items: FleetJob[] } & Failed> {
  return perServerDetailed(async (server, agent) => ((await agent.jobs()) ?? []).map((job) => ({ server, job })));
}
