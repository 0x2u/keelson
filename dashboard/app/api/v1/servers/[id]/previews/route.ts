import { json, serverRoute } from "@/lib/api-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => json(200, { previews: (await agent.previews()) ?? [] }));
}
