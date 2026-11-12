import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Public health check of the dashboard itself: 200 when the database opens and the master key is the one the data was written
 * with, 503 with a coarse reason otherwise (never more: it is reachable by anyone).
 */
export function GET() {
  const verdict = checkHealth();
  if (verdict.ok) return Response.json({ status: "ok" });
  return Response.json({ status: "unhealthy", reason: verdict.reason }, { status: 503 });
}
