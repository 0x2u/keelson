import { relayMachine, takeRequestBody } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const refuse = (status: number, error: string): Response => Response.json({ error }, { status });

/**
 * The body of the request `id` that was sent to this machine with `stream: true` (an image archive), once, as a stream
 * that is read from its source only as fast as the machine takes it. Nothing here holds more than a chunk of it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const machine = relayMachine(request);
  if (!machine) return refuse(401, "unknown credential");
  const { id } = await params;

  const taken = takeRequestBody(machine.id, id, request.signal);
  if (taken.status !== 200) {
    return refuse(taken.status, { 404: "unknown request, or it has no streamed body", 409: "the body was taken already", 410: "nobody waits for this request any more" }[taken.status]);
  }
  return new Response(taken.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-transform", // no transform: the bytes are an archive that has to arrive as sent
      "X-Accel-Buffering": "no", // keep a reverse proxy from buffering the stream
    },
  });
}
