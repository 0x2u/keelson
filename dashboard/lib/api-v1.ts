import "server-only";
import { AgentError, agentFor, type AgentClient } from "@/lib/agent";
import { findApiToken, touchApiToken } from "@/lib/api-tokens";
import { parseBearer, tokenAllows, tokenStatus, type ApiScope, type ApiToken } from "@/lib/api-tokens-core";
import { audit, isLoginBlocked, loginBlockedForMs, recordLoginFailure } from "@/lib/auth/store";
import { requestIp } from "@/lib/client-ip";
import { getCredentials, type ServerCredentials } from "@/lib/servers";

// The REST API under /api/v1: every route authenticates itself with a bearer token (the proxy lets these paths
// through without a session, like the webhook). This file is the one place that decides who may call, and how a
// failure is told.

/** Every response is JSON and is never cached: it may be about a deployment that is running. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const failure = (status: number, error: string, headers?: Record<string, string>): Response => json(status, { error }, headers);

/**
 * Failures of one client address share the sign-in throttle's mechanism (and window and limit), under their own key:
 * a guessing script cannot lock the operator out of signing in, and an unauthorised call is never audited one by one,
 * so a flood cannot fill the log.
 */
const throttleKey = (ip: string): string => `api:${ip}`;

export interface Caller {
  token: ApiToken;
  ip: string;
}

export type Gate = { ok: true; caller: Caller } | { ok: false; response: Response };

/** The label that stands for a token in the dashboard's audit log. */
export function actorOf(token: Pick<ApiToken, "name">): string {
  return `token:${token.name}`;
}

/** The same label for the agent's audit log: printable ASCII only, so it can travel in a header. */
function agentActorOf(token: Pick<ApiToken, "name">): string {
  return actorOf(token).replace(/[^\x20-\x7e]/g, "?");
}

const UNAUTHORIZED = "unauthorized";

function unauthorized(ip: string): Gate {
  recordLoginFailure(throttleKey(ip));
  return { ok: false, response: failure(401, UNAUTHORIZED, { "WWW-Authenticate": 'Bearer realm="keelson"' }) };
}

/**
 * Who is calling, and whether they may. 401 (one body for a missing, malformed, unknown, revoked or expired token),
 * 403 for a valid token that may not do this (audited), 429 for a client that failed too often.
 */
export function authenticate(request: Request, need: { scope: ApiScope; serverId?: string; unrestricted?: boolean }): Gate {
  const ip = requestIp(request);
  if (isLoginBlocked(throttleKey(ip))) {
    const seconds = Math.max(1, Math.ceil(loginBlockedForMs(throttleKey(ip)) / 1000));
    return { ok: false, response: failure(429, "too many failed attempts", { "Retry-After": String(seconds) }) };
  }
  const secret = parseBearer(request.headers.get("authorization"));
  if (secret === null) return unauthorized(ip);
  const token = findApiToken(secret);
  if (token === null || tokenStatus(token, Date.now()) !== "active") return unauthorized(ip);

  const verdict =
    need.unrestricted && token.servers !== null
      ? { ok: false as const, reason: "this needs a token that is not limited to some servers" }
      : tokenAllows(token, need.scope, need.serverId);
  if (!verdict.ok) {
    audit("api_denied", `${request.method} ${new URL(request.url).pathname}: ${verdict.reason}`, ip, actorOf(token));
    return { ok: false, response: failure(403, `forbidden: ${verdict.reason}`) };
  }
  touchApiToken(token.id, ip);
  return { ok: true, caller: { token, ip } };
}

/** What a token may see: the registry filtered by its server list. */
export function visibleTo(token: ApiToken, id: string): boolean {
  return token.servers === null || token.servers.includes(id);
}

/** A thrown failure becomes a response: nothing but a short reason ever leaves, never a stack or a credential. */
export function toResponse(err: unknown): Response {
  if (err instanceof AgentError) {
    if (err.status === 0) return failure(502, `agent unreachable: ${err.message.replace(/^cannot reach the agent: /, "")}`);
    if (err.status === 400 || err.status === 404 || err.status === 409) return failure(err.status, err.message);
    return failure(502, `agent error: ${err.message}`);
  }
  console.error("api v1:", err);
  return failure(500, "internal error");
}

export interface ServerCall {
  caller: Caller;
  server: ServerCredentials;
  agent: AgentClient;
  request: Request;
}

/** A route about one server: authenticates, finds the server, and turns failures into answers. */
export async function serverRoute(
  request: Request,
  serverId: string,
  scope: ApiScope,
  run: (call: ServerCall) => Promise<Response>,
): Promise<Response> {
  const gate = authenticate(request, { scope, serverId });
  if (!gate.ok) return gate.response;
  const server = getCredentials(serverId);
  if (!server) return failure(404, "server not found");
  try {
    return await run({ caller: gate.caller, server, agent: agentFor(server, agentActorOf(gate.caller.token)), request });
  } catch (err) {
    return toResponse(err);
  }
}

/** A route not about one server (the list of servers, projects, audit). */
export async function fleetRoute(
  request: Request,
  scope: ApiScope,
  run: (caller: Caller) => Promise<Response>,
  options: { unrestricted?: boolean } = {},
): Promise<Response> {
  const gate = authenticate(request, { scope, ...options });
  if (!gate.ok) return gate.response;
  try {
    return await run(gate.caller);
  } catch (err) {
    return toResponse(err);
  }
}

/** A whole number between `min` and `max` from a query parameter; the default when it is absent; null when it is invalid. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}
