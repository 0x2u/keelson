import { acceptChunk, failRequest, relayMachine } from "@/lib/relay";
import { RELAY_MAX_CHUNK_BYTES, parseRelayHeaders, readBounded } from "@/lib/relay-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const refuse = (status: number, error: string): Response => Response.json({ error }, { status });

/** One chunk of a machine's answer to the request `id`; held back while the consumer of the answer is slow. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const machine = relayMachine(request);
  if (!machine) return refuse(401, "unknown credential");
  const { id } = await params;

  const h = request.headers;
  const seq = Number(h.get("x-relay-seq"));
  const end = h.get("x-relay-end") === "1";
  let head: { status: number; headers: Headers } | undefined;
  let invalid: string | null = Number.isInteger(seq) && seq >= 0 ? null : "bad sequence number";
  if (invalid === null && seq === 0) {
    const status = Number(h.get("x-relay-status"));
    const headers = parseRelayHeaders(h.get("x-relay-headers"));
    if (!Number.isInteger(status) || status < 200 || status > 599 || headers === null) invalid = "bad status or headers";
    else head = { status, headers };
  }
  if (invalid !== null) {
    failRequest(machine.id, id, `the machine sent an invalid answer (${invalid})`);
    return refuse(400, invalid);
  }
  const data = await readBounded(request, RELAY_MAX_CHUNK_BYTES);
  if (data === null) {
    failRequest(machine.id, id, "the machine sent a chunk larger than 4 MiB");
    return refuse(413, "chunk too large");
  }
  const status = await acceptChunk(machine.id, id, { seq, head, end, data });
  return status === 200 ? new Response(null, { status }) : refuse(status, { 404: "unknown request", 409: "bad sequence or already ended", 410: "nobody waits for this answer" }[status]);
}
