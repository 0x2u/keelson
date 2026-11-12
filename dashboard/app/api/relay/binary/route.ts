import { agentBinary, binaryResponse } from "@/lib/agent-binaries";
import { parseAgentTarget } from "@/lib/agent-binaries-core";
import { relayCodeAllowsBinary } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The agent binary for a machine that is about to connect, fetched by the connect command with the code it was given (no
 * browser session, no quarantine flag on a Mac), or for a server that replaces its agent with an upgrade code, which
 * authorises nothing else. The code is not spent here: the enrolment does that.
 */
export function GET(request: Request): Response {
  const q = new URL(request.url).searchParams;
  const code = q.get("code");
  if (code === null || !relayCodeAllowsBinary(code)) return Response.json({ error: "invalid or expired code" }, { status: 401 });
  const target = parseAgentTarget(q.get("os"), q.get("arch"));
  if (!target) return Response.json({ error: "unsupported platform: use os=linux|darwin and arch=amd64|arm64" }, { status: 404 });
  try {
    return binaryResponse(agentBinary(target.arch, target.os));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unavailable" }, { status: 404 });
  }
}
