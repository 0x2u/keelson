import { agentFor } from "@/lib/agent";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { agentUpdate, offersUpdate } from "@/lib/agent-binaries-core";
import { fleetRoute, json, visibleTo } from "@/lib/api-v1";
import { serverView } from "@/lib/api-v1-views";
import { getCredentials, listServers, markSeen } from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return fleetRoute(request, "read", async ({ token }) => {
    const bundled = bundledAgentVersion();
    const servers = await Promise.all(
      listServers()
        .filter((s) => visibleTo(token, s.id))
        .map(async (s) => {
          const creds = getCredentials(s.id);
          try {
            const info = await agentFor(creds!).info();
            markSeen(s.id);
            return serverView(s, token, { online: true, agentVersion: info.version, updateAvailable: offersUpdate(agentUpdate(info.version, bundled)) });
          } catch {
            return serverView(s, token, { online: false, agentVersion: null, updateAvailable: false });
          }
        }),
    );
    return json(200, { servers });
  });
}
