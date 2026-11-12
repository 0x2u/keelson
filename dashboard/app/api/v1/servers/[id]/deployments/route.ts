import { failure, intParam, json, serverRoute } from "@/lib/api-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serverRoute(request, id, "read", async ({ agent }) => {
    const query = new URL(request.url).searchParams;
    const limit = intParam(query.get("limit"), 20, 1, 100);
    if (limit === null) return failure(400, "limit must be between 1 and 100");
    const app = query.get("app") || undefined;
    if (app !== undefined && !APP.test(app)) return failure(400, "invalid app");
    return json(200, { deployments: await agent.deployments(app, limit) });
  });
}
