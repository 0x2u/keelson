import type { AttentionItem, ServerSnapshot, Summary } from "@/lib/attention-core";
import { itemsOf, summarize } from "@/lib/attention-core";
import { canRunApps } from "@/lib/machine-core";
import { agentUpdate, offersUpdate } from "@/lib/agent-binaries-core";
import type { Deployment } from "@/lib/agent-types";
import { loadTone, usageTone } from "@/lib/health-core";
import type { Tone } from "@/lib/status";

// What the Servers page lists, per server, derived from what the fleet loader read. Pure: the page lays it out. A part
// the agent did not answer is `undefined` here ("can't tell"), never zero: an empty count would claim there is nothing.

/** What one server answered, as the fleet loader reads it (see lib/fleet.ts). */
export interface FleetServerInput extends ServerSnapshot {
  url: string;
  /** "relay": no address, it connects out. A relay server that does not `serves` does not serve traffic: being off is its normal state. */
  transport: "direct" | "relay";
  serves: boolean;
  canDeploy: boolean;
  version?: string;
  readOnly?: boolean;
  deployments?: Deployment[];
}

export interface ServerRow {
  id: string;
  name: string;
  url: string;
  /** The server connects out to this dashboard: the list says so instead of showing an address. */
  relay: boolean;
  /** A server that does not serve traffic (a computer that connects out and runs no apps): off is not an incident, and it is updated on the machine itself. */
  machine: boolean;
  reachable: boolean;
  /** Why the agent did not answer. */
  reason?: string;
  /** When the dashboard last had an answer from it (ms), or null if never. */
  lastSeen: number | null;
  version?: string;
  /** The dashboard carries an agent that is newer than the one running, or that differs in a way with no order (a hash). */
  updateAvailable: boolean;
  /** The agent runs a newer version than the one this dashboard carries: update the dashboard first, no downgrade is offered. */
  newerThanDashboard: boolean;
  readOnly: boolean;
  /** Apps declared; undefined when unknown, null for an agent with no apps file. */
  apps?: number | null;
  containers?: { running: number; total: number };
  /** The verdict the attention model gives this server (it also says "unreachable"). */
  verdict: Summary;
  /** The most urgent thing, in a line. */
  headline?: string;
  /** `trigger` and `status` tell a roll back from a deploy; the column has no room for the version, so the badge says plain "Rolled back". */
  lastDeployment?: { id: string; app: string; status: string; trigger: string; at: string } | null;
  disk?: { free: number; total: number; tone: Tone };
  /** Memory in use (what is not available to a new process), whole percent, with the same tone as the server's verdict. */
  memory?: { used: number; total: number; percent: number; tone: Tone };
  /** The 1-minute load per CPU (two decimals), with the same tone as the server's verdict. */
  load?: { one: number; cpus: number; perCpu: number; tone: Tone };
}

/** The memory of a host as the list shows it; undefined when the agent does not report it. */
export function memoryOf(memory: { total: number; available: number } | undefined): ServerRow["memory"] {
  if (!memory || memory.total <= 0) return undefined;
  const used = Math.max(0, memory.total - memory.available);
  return { used, total: memory.total, percent: Math.min(100, Math.round((used / memory.total) * 100)), tone: usageTone(used, memory.total) };
}

/** The load of a host per CPU; undefined when the agent does not report it or the CPU count is unknown. */
export function loadOf(load: { one: number } | undefined, cpus: number): ServerRow["load"] {
  if (!load || cpus <= 0) return undefined;
  return { one: load.one, cpus, perCpu: Math.round((load.one / cpus) * 100) / 100, tone: loadTone(load.one, cpus) };
}

const RANK: Record<Tone, number> = { danger: 3, warning: 2, info: 1, muted: 0, success: 0 };

function latest(list: Deployment[] | undefined): Deployment | undefined {
  let found: Deployment | undefined;
  for (const d of list ?? []) if (!found || Date.parse(d.started_at) > Date.parse(found.started_at)) found = d;
  return found;
}

/** The rows of the Servers page: servers that need a look first (unreachable, then by how bad), then by name. */
export function serverRows(servers: FleetServerInput[], items: AttentionItem[], bundledVersion: string | null): ServerRow[] {
  const rows = servers.map((s): ServerRow => {
    const memory = s.reachable ? memoryOf(s.system?.host.memory) : undefined;
    const load = s.reachable ? loadOf(s.system?.host.load, s.system?.host.cpus ?? 0) : undefined;
    const mine = itemsOf(items, s.server.id);
    const relay = s.transport === "relay";
    const machine = !canRunApps(s);
    // A server that does not serve traffic is not an incident when it is off: it is Offline, below the servers that need a look. A server that
    // connects out and runs apps is one when it is not connected, like a direct server that does not answer.
    const verdict = s.reachable ? summarize(mine) : machine ? { tone: "muted" as const, label: "Offline", count: 0 } : { tone: "danger" as const, label: "Unreachable", count: Math.max(1, mine.length) };
    const last = latest(s.deployments);
    const disk = s.system?.host.disk;
    return {
      id: s.server.id,
      name: s.server.name,
      url: s.url,
      relay,
      machine,
      reachable: s.reachable,
      ...(s.reason === undefined ? {} : { reason: s.reason }),
      lastSeen: s.lastSeen,
      ...(s.version === undefined ? {} : { version: s.version }),
      // A server that does not serve traffic is updated on the machine itself, not through the dashboard.
      updateAvailable: !machine && s.version !== undefined && offersUpdate(agentUpdate(s.version, bundledVersion)),
      newerThanDashboard: !machine && s.version !== undefined && agentUpdate(s.version, bundledVersion) === "newer",
      readOnly: s.readOnly === true,
      ...(s.reachable && s.apps !== undefined ? { apps: s.apps === null ? null : s.apps.length } : {}),
      ...(s.reachable && s.containers ? { containers: { running: s.containers.filter((c) => c.state === "running").length, total: s.containers.length } } : {}),
      verdict,
      ...(s.reachable && mine[0] ? { headline: mine[0].message } : {}),
      ...(s.reachable && s.deployments !== undefined ? { lastDeployment: last ? { id: last.id, app: last.app, status: last.status, trigger: last.trigger, at: last.started_at } : null } : {}),
      ...(s.reachable && disk ? { disk: { free: disk.free, total: disk.total, tone: usageTone(disk.total - disk.free, disk.total) } } : {}),
      ...(memory ? { memory } : {}),
      ...(load ? { load } : {}),
    };
  });
  return rows.sort((a, b) => RANK[b.verdict.tone] - RANK[a.verdict.tone] || b.verdict.count - a.verdict.count || a.name.localeCompare(b.name));
}
