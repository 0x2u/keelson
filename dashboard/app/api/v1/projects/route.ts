import { fleetRoute, json, visibleTo } from "@/lib/api-v1";
import { appView, canDeployWith } from "@/lib/api-v1-views";
import { loadPlacements } from "@/lib/projects";
import { groupProjects } from "@/lib/projects-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return fleetRoute(request, "read", async ({ token }) => {
    const { placements, unreachable, readOnly } = await loadPlacements((serverId) => visibleTo(token, serverId));
    // What a server's `canDeploy` says here is about this token: a read token deploys nowhere. Its `host` is for the dashboard's pages, not the API.
    const forToken = <T extends { canDeploy: boolean; host?: string | null }>(server: T): Omit<T, "host"> => {
      const { host, ...rest } = server;
      void host;
      return { ...rest, canDeploy: canDeployWith(token, server.canDeploy) };
    };
    const mine = placements.map((p) => ({ ...p, app: appView(p.app), server: forToken(p.server) }));
    return json(200, { projects: groupProjects(mine), unreachable: unreachable.map((entry) => { const { reason, ...server } = entry; void reason; return forToken(server); }), read_only: readOnly.map(forToken) });
  });
}
