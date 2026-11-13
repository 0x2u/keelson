import "server-only";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { fleetDelivery, type FleetDelivery, type Range, type ServerReport } from "@/lib/delivery-core";
import { getCredentials, listServers } from "@/lib/servers";

/** What the page shows: the fleet's numbers and what each server answered. */
export interface DeliveryFeed {
  range: Range;
  fleet: FleetDelivery;
  reports: ServerReport[];
}

/** Asks every server for its delivery numbers over the range, at the same time. */
export async function loadDelivery(range: Range): Promise<DeliveryFeed> {
  const reports = await Promise.all(
    listServers().map(async (s): Promise<ServerReport> => {
      const server = { id: s.id, name: s.name };
      const creds = getCredentials(s.id);
      if (!creds) return { server, delivery: null, problem: "this server is no longer registered" };
      const out = await load(agentFor(creds).delivery(range));
      if (out.error !== undefined) return { server, delivery: null, problem: out.error };
      if (out.data === null) {
        return { server, delivery: null, problem: "this agent is too old to report its delivery numbers: update it from the server's page" };
      }
      return { server, delivery: out.data };
    }),
  );
  return { range, fleet: fleetDelivery(reports), reports };
}
