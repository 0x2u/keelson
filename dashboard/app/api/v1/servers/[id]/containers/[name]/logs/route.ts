import { failure, intParam, json, serverRoute } from "@/lib/api-v1";
import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX, readLogs } from "@/lib/api-v1-streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => {
    const tail = intParam(new URL(request.url).searchParams.get("tail"), LOG_TAIL_DEFAULT, 1, LOG_TAIL_MAX);
    if (tail === null) return failure(400, `tail must be between 1 and ${LOG_TAIL_MAX}`);
    return json(200, await readLogs(agent, name, tail));
  });
}
