import type { Config } from "./config.ts";
import { redact } from "./redact.ts";
import { VERSION } from "./version.ts";

/** A failure of a request to the dashboard, already mapped to a message that is safe to show. */
export class KeelsonApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "KeelsonApiError";
    this.status = status;
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE = 300;

type Query = Record<string, string | number | undefined>;

/** One line, no control characters, no token, bounded: for text that comes from a response. */
function cleanMessage(text: string, token: string): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const safe = redact(oneLine, token);
  return safe.length > MAX_MESSAGE ? `${safe.slice(0, MAX_MESSAGE)}…` : safe;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** `forbidden: reason` -> `reason`, and `agent unreachable: x` stays whole: the dashboard's message, tidied. */
function bodyError(body: unknown, token: string): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return cleanMessage(body.error, token);
  }
  return "";
}

export class KeelsonClient {
  readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.token = config.token;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** The origin shown in messages. */
  get origin(): string {
    return new URL(this.baseUrl).origin;
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.request("GET", path, query);
  }

  /** Never retried: a write that timed out may still have happened, and the operator must decide. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, undefined, body);
  }

  private async request(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      "user-agent": `keelson-mcp/${VERSION}`,
    };
    const init: RequestInit = {
      method,
      headers,
      // A redirect would carry the token to wherever it points.
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, init);
      text = await readLimited(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw this.networkError(err);
    }

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) throw this.statusError(res.status, parsed, res.headers.get("retry-after"));
    if (parsed === undefined) throw new KeelsonApiError(`Unexpected response from Keelson (HTTP ${res.status}, not JSON).`, res.status);
    return parsed;
  }

  private networkError(err: unknown): KeelsonApiError {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return new KeelsonApiError(`Keelson did not answer within ${this.timeoutMs % 1000 ? `${this.timeoutMs} ms` : `${this.timeoutMs / 1000} s`} (${this.origin}).`);
    }
    if (err instanceof ResponseTooLarge) return new KeelsonApiError("Keelson's response is too large to read.");
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
    const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : "";
    const detail = code || (/redirect/i.test(cause?.message ?? "") ? "unexpected redirect" : "connection failed");
    return new KeelsonApiError(`Cannot reach Keelson at ${this.origin}: ${cleanMessage(detail, this.token)}.`);
  }

  private statusError(status: number, body: unknown, retryAfter: string | null): KeelsonApiError {
    const message = bodyError(body, this.token);
    switch (status) {
      case 401:
        return new KeelsonApiError("Keelson rejected the token: token invalid, expired or revoked.", 401);
      case 403:
        return new KeelsonApiError(`Forbidden: ${message.replace(/^forbidden:\s*/i, "") || "the token may not do this"}.`, 403);
      case 429: {
        const seconds = retryAfterSeconds(retryAfter);
        return new KeelsonApiError(
          `Rate limited by Keelson (too many failed requests). Retry ${seconds === undefined ? "later" : `after ${seconds} s`}.`,
          429,
        );
      }
      case 502:
        return new KeelsonApiError(message || "agent unreachable", 502);
      case 400:
        return new KeelsonApiError(`Rejected (HTTP 400): ${message || "bad request"}`, 400);
      case 404:
        return new KeelsonApiError(`Not found (HTTP 404): ${message || "unknown server, app, job or deployment"}`, 404);
      case 409:
        return new KeelsonApiError(`Conflict (HTTP 409): ${message || "the agent is busy with another operation"}`, 409);
      default:
        return new KeelsonApiError(`Keelson returned HTTP ${status}${message ? `: ${message}` : ""}`, status);
    }
  }
}

class ResponseTooLarge extends Error {}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
