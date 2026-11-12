import { proxyAgentStream } from "@/lib/stream-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  return proxyAgentStream(request, id, `/v1/containers/${encodeURIComponent(name)}/stats`);
}
