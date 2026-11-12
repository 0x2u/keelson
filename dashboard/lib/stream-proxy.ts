import "server-only";
import { AgentError, agentFor } from "@/lib/agent";
import { hasSession } from "@/lib/session";
import { getCredentials } from "@/lib/servers";

/** The query parameters of the agent API that may pass through from the browser. */
const ALLOWED_QUERY = ["follow", "tail", "since", "stream"];

function json(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Proxies a Server-Sent Events stream from an agent to the browser. The browser
 * never learns the agent's address or any credential: it only talks to this
 * dashboard, with its session cookie. Closing the browser tab aborts the
 * upstream request through request.signal.
 */
export async function proxyAgentStream(request: Request, serverId: string, agentPath: string): Promise<Response> {
  if (!(await hasSession())) return json(401, "unauthorized");
  const server = getCredentials(serverId);
  if (!server) return json(404, "server not found");

  const query = new URLSearchParams();
  const incoming = new URL(request.url).searchParams;
  for (const key of ALLOWED_QUERY) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const path = query.size > 0 ? `${agentPath}?${query}` : agentPath;

  try {
    const upstream = await agentFor(server).stream(path, request.signal);
    // undici and the DOM declare the same web stream with different types.
    const body = upstream.body as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no", // keep a reverse proxy from buffering the stream
      },
    });
  } catch (err) {
    // Client mistakes (unknown container, bad name) keep their meaning; anything else is a bad gateway.
    if (err instanceof AgentError) return json(err.status === 404 || err.status === 400 ? err.status : 502, err.message);
    return json(502, "unexpected error talking to the agent");
  }
}
