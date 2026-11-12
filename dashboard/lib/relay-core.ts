// Pure parts of the relay (machines that connect out to the dashboard): the wire format's helpers and limits. No
// "server-only": tests import it. The hub that uses them is lib/relay.ts.

import { createHash } from "node:crypto";
import { validServerName } from "@/lib/enroll-core";
import { MIN_SECRET_LENGTH, SERVER_NAME_MAX } from "@/lib/server-input";

export const RELAY_PREFIX = "ksr1.";
/** How long an enrolment code lives. */
export const RELAY_CODE_TTL_MS = 30 * 60_000;
/** Seconds between pings on an idle connection: also what keeps a proxy from closing it. */
export const RELAY_PING_EVERY_S = 15;
/** Largest request body sent inside a line of the connection to a machine that connected out. */
export const RELAY_MAX_REQUEST_BYTES = 1024 * 1024;
/** Largest request body streamed to a machine that connected out (an image archive); the machine refuses more as well. */
export const RELAY_MAX_STREAM_BYTES = 8 * 1024 ** 3;
/** What a machine announces in `X-Relay-Features` when it connects: it can fetch a request's body (`stream: true`) itself. */
export const RELAY_FEATURE_REQUEST_STREAM = "request-stream";
/** Largest chunk of an answer the dashboard accepts in one POST. */
export const RELAY_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** Requests in flight to one machine at once. */
export const RELAY_MAX_IN_FLIGHT = 64;

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `ksr1.` + base64url of {"u": dashboard URL, "c": code}: what the operator pastes on the machine. */
export function encodeConnection(url: string, code: string): string {
  return RELAY_PREFIX + Buffer.from(JSON.stringify({ u: url, c: code })).toString("base64url");
}

/** The dashboard URL and code in a connection string, or null when it is not one. */
export function parseConnection(text: string): { url: string; code: string } | null {
  const s = text.trim();
  if (!s.startsWith(RELAY_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(s.slice(RELAY_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { u, c } = value as Record<string, unknown>;
  return typeof u === "string" && u !== "" && typeof c === "string" && c !== "" ? { url: u, code: c } : null;
}

/**
 * The command that turns the machine it is pasted on into a build machine (POSIX sh: Mac and Linux). The binary is
 * fetched by code, so it needs no browser session and carries no quarantine flag on a Mac. `uname` is left for the
 * machine to answer.
 */
export function connectLine(code: string, origin: string): string {
  const query = "os=$(uname -s | tr A-Z a-z)&arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')";
  return `curl -fsSL "${origin}/api/relay/binary?${query}&code=${code}" -o keelson-agent && chmod +x keelson-agent && ./keelson-agent connect ${encodeConnection(origin, code)}`;
}

export interface EnrolRequest {
  code: string;
  name: string;
  token: string;
  deploySecret: string;
  version: string;
  os: string;
  arch: string;
  hostname: string;
  /** A full agent that runs apps (the one-command install); false (or absent, an older agent) is a build machine. */
  serves: boolean;
}

const INFO_MAX = 200;

/** The enrolment body a machine sends, or null when it is malformed (a name the dashboard would refuse included). */
export function parseEnrolRequest(body: unknown): EnrolRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const v = b[key] ?? "";
    return typeof v === "string" && v.length <= max ? v : null;
  };
  const code = text("code", 200);
  const name = text("name", SERVER_NAME_MAX)?.trim() ?? null;
  const token = text("token", 512);
  const deploySecret = text("deploy_secret", 512);
  const version = text("version", INFO_MAX);
  const os = text("os", INFO_MAX);
  const arch = text("arch", INFO_MAX);
  const hostname = text("hostname", INFO_MAX);
  const serves = b.serves === undefined ? false : b.serves;
  if (typeof serves !== "boolean") return null;
  if (code === null || code === "" || name === null || !validServerName(name) || name.length > SERVER_NAME_MAX) return null;
  if (token === null || deploySecret === null || version === null || os === null || arch === null || hostname === null) return null;
  // They end up in the audit log: a line break or another control character would forge an entry.
  if ([version, os, arch, hostname].some((v) => /[\u0000-\u001f\u007f]/.test(v))) return null;
  if (token.length < MIN_SECRET_LENGTH || deploySecret.length < MIN_SECRET_LENGTH || token === deploySecret) return null;
  return { code, name, token, deploySecret, version, os, arch, hostname, serves };
}

/**
 * The headers of an answer, from the `X-Relay-Headers` value (base64 of a JSON object of strings). Anything that is not
 * a header this dashboard could hand to a Response is dropped: the agent is trusted with its own answers, not with the
 * framing of this one.
 */
export function parseRelayHeaders(value: string | null): Headers | null {
  const headers = new Headers();
  if (value === null || value === "") return headers;
  let object: unknown;
  try {
    object = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return null;
  for (const [name, v] of Object.entries(object)) {
    if (typeof v !== "string" || /^(content-length|transfer-encoding|connection|set-cookie)$/i.test(name)) continue;
    try {
      headers.set(name, v);
    } catch {
      /* not a legal header: skip it */
    }
  }
  return headers;
}

/** The features in an `X-Relay-Features` value (comma-separated names). Names this dashboard does not know are kept: a newer agent may announce more. */
export function parseRelayFeatures(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name)),
  );
}

/** The body of a request, or null when it is larger than `max` bytes (reading stops there: a flood is not held in memory). */
export async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
