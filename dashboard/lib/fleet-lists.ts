import "server-only";
import { cache } from "react";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { loadRunningFleet } from "@/lib/fleet";
import { fleetLists, type FleetLists, type ListFacts } from "@/lib/resource-lists-core";
import { getCredentials } from "@/lib/servers";

/**
 * Every job and database of every server that runs things, each with its project, for the global lists (`/jobs`,
 * `/databases`). A server's configuration is read as well, because it is what says which project a job or database belongs
 * to; a configuration that cannot be read only means that the labels in it are unknown. Started once per request.
 */
export const loadFleetLists = cache(async (): Promise<FleetLists & { generatedAt: number }> => {
  const generatedAt = Date.now();
  const fleet = await loadRunningFleet();
  const facts = await Promise.all(
    fleet.map(async (f): Promise<ListFacts> => {
      const creds = f.reachable ? getCredentials(f.server.id) : null;
      const config = creds ? await load(agentFor(creds).config()) : null;
      return {
        server: { ...f.server, canDeploy: f.canDeploy },
        reachable: f.reachable,
        ...(f.reason === undefined ? {} : { reason: f.reason }),
        apps: f.apps,
        jobs: f.jobs,
        databases: f.databases,
        ...(f.errors === undefined ? {} : { errors: f.errors }),
        config: config !== null && config.error === undefined && config.data !== null ? config.data.model : null,
      };
    }),
  );
  return { ...fleetLists(facts), generatedAt };
});
