import "server-only";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { groupProjects, jobsOf, type Placement, type ServerRef } from "@/lib/projects-core";
import { runTargets } from "@/lib/machine-core";
import { serverHostOf } from "@/lib/published-address-core";
import { getCredentials, listServers } from "@/lib/servers";

export interface Loaded {
  placements: Placement[];
  /** Servers that did not answer, with why: their apps are missing from the view, and the view says so. */
  unreachable: (ServerRef & { reason: string })[];
  /** Servers whose agent has no deployments (read-only): there is nothing of theirs to show. */
  readOnly: ServerRef[];
}

/**
 * Every app of every server that runs apps (of those `allowed` says yes to, when given), with the jobs that run in it. A server that
 * fails contributes nothing but its name.
 */
export async function loadPlacements(allowed?: (serverId: string) => boolean): Promise<Loaded> {
  const perServer = await Promise.all(
    runTargets(listServers()).filter((s) => allowed === undefined || allowed(s.id)).map(async (s) => {
      const ref: ServerRef = { id: s.id, name: s.name, canDeploy: s.canDeploy, host: serverHostOf(s) };
      const creds = getCredentials(s.id);
      if (!creds) return { ref, state: "unreachable" as const, reason: "this server is no longer registered", placements: [] as Placement[] };
      const agent = agentFor(creds);
      const [apps, jobs] = await Promise.all([load(agent.apps()), load(agent.jobs())]);
      if (apps.error !== undefined) return { ref, state: "unreachable" as const, reason: apps.error, placements: [] as Placement[] };
      if (apps.data === null) return { ref, state: "readOnly" as const, placements: [] as Placement[] };
      const list = jobs.data ?? [];
      return { ref, state: "ok" as const, placements: apps.data.map((app): Placement => ({ server: ref, app, jobs: jobsOf(app.name, list) })) };
    }),
  );
  return {
    placements: perServer.flatMap((r) => r.placements),
    unreachable: perServer.flatMap((r) => (r.state === "unreachable" ? [{ ...r.ref, reason: r.reason }] : [])),
    readOnly: perServer.filter((r) => r.state === "readOnly").map((r) => r.ref),
  };
}

/** The names of the projects the servers run, for a form that assigns something to one. */
export async function projectNames(): Promise<string[]> {
  return groupProjects((await loadPlacements()).placements).map((p) => p.name);
}
