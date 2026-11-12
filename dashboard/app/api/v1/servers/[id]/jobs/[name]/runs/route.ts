import { failure, intParam, json, serverRoute } from "@/lib/api-v1";
import { runView } from "@/lib/api-v1-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => {
    const limit = intParam(new URL(request.url).searchParams.get("limit"), 20, 1, 100);
    if (limit === null) return failure(400, "limit must be between 1 and 100");
    return json(200, { runs: (await agent.jobRuns(name, limit)).map(runView) });
  });
}
