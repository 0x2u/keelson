import { json, serverRoute } from "@/lib/api-v1";
import { appView, containerView, serverView } from "@/lib/api-v1-views";
import { agentUpdate, offersUpdate } from "@/lib/agent-binaries-core";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import { markSeen } from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serverRoute(request, id, "read", async ({ agent, server, caller }) => {
    // The same data as the server page. An agent that does not answer at all is a 502 for the whole call.
    const [info, system, containers, apps] = await Promise.all([agent.info(), agent.system(), agent.containers(true), agent.apps()]);
    markSeen(server.id);
    const updateAvailable = offersUpdate(agentUpdate(info.version, bundledAgentVersion()));
    return json(200, {
      server: serverView(server, caller.token, { online: true, agentVersion: info.version, updateAvailable }),
      health: { info, system },
      containers: containers.map(containerView),
      apps: (apps ?? []).map(appView),
    });
  });
}
