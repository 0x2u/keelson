import { failure, fleetRoute, intParam, json } from "@/lib/api-v1";
import { recentAudit } from "@/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // The dashboard's log is about the whole dashboard (sign-ins, every server): a token limited to some servers does not read it.
  return fleetRoute(request, "read", async () => {
    const limit = intParam(new URL(request.url).searchParams.get("limit"), 50, 1, 200);
    if (limit === null) return failure(400, "limit must be between 1 and 200");
    const entries = recentAudit(limit).map((e) => ({ id: e.id, at: new Date(e.at).toISOString(), event: e.event, actor: e.actor, detail: e.detail, ip: e.ip }));
    return json(200, { entries });
  }, { unrestricted: true });
}
