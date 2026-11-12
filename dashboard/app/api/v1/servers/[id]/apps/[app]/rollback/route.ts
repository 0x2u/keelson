import { rollbackFromRequest } from "@/lib/api-v1-writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; app: string }> }) {
  const { id, app } = await params;
  return rollbackFromRequest(request, id, app);
}
