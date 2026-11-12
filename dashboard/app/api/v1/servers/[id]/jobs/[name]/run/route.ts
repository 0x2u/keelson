import { runJobFromRequest } from "@/lib/api-v1-writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  return runJobFromRequest(request, id, name);
}
