import { openRelayConnection, relayMachine } from "@/lib/relay";
import { parseRelayFeatures } from "@/lib/relay-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The connection a machine keeps open: requests for it come down this NDJSON stream, as long as it lives. */
export function GET(request: Request): Response {
  const machine = relayMachine(request);
  if (!machine) return Response.json({ error: "unknown credential" }, { status: 401 });
  const features = parseRelayFeatures(request.headers.get("x-relay-features"));
  return new Response(openRelayConnection(machine.id, request.signal, features), {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", // keep a reverse proxy from buffering the stream
    },
  });
}
