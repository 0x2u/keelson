import { json, serverRoute } from "@/lib/api-v1";
import { appView } from "@/lib/api-v1-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // An agent without deployments has no apps: an empty list, not an error.
  return serverRoute(request, id, "read", async ({ agent }) => json(200, { apps: ((await agent.apps()) ?? []).map(appView) }));
}
