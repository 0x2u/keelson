import { json, serverRoute } from "@/lib/api-v1";
import { readDeploymentEvents } from "@/lib/api-v1-streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; deployment: string }> }) {
  const { id, deployment } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => {
    const found = await agent.deployment(deployment);
    return json(200, { ...found, events: await readDeploymentEvents(agent, deployment, found.status === "running") });
  });
}
