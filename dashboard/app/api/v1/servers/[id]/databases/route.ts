import { json, serverRoute } from "@/lib/api-v1";
import { databaseView } from "@/lib/api-v1-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => json(200, { databases: ((await agent.databases()) ?? []).map(databaseView) }));
}
