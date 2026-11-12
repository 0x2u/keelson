import { NextResponse } from "next/server";
import { agentBinary, binaryResponse } from "@/lib/agent-binaries";
import { parseAgentTarget } from "@/lib/agent-binaries-core";
import { hasSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The agent binary this dashboard ships, for installing it by hand on a server (see the "Run it yourself" tab). */
export async function GET(_request: Request, { params }: { params: Promise<{ arch: string }> }) {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const target = parseAgentTarget("linux", (await params).arch);
  if (!target) return NextResponse.json({ error: "unknown architecture: use amd64 or arm64" }, { status: 404 });
  try {
    return binaryResponse(agentBinary(target.arch));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "unavailable" }, { status: 404 });
  }
}
