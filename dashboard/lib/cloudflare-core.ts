/**
 * What Keelson needs to know about Cloudflare, without the network: reading its answers, choosing the zone of a host
 * name, saying what its errors mean, and deciding what to do about an existing DNS record. No token ever passes through
 * here.
 */

import { z } from "zod";
import { cleanHostname, recordType, sameIp, type IpFamily } from "@/lib/address-core";

export interface CfZone {
  id: string;
  /** Lower case, as the zone is registered (example.com, example.co.uk). */
  name: string;
}

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export type CloudflareErrorCode = "invalid_token" | "forbidden" | "not_found" | "rate_limited" | "unreachable" | "unexpected";

/** An error whose message is fit for the operator: never the token, never a raw API body. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly code: CloudflareErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

// ---- the answers ----

const ApiError = z.object({ code: z.number().optional(), message: z.string().optional() });
const Envelope = z.object({
  success: z.boolean().optional(),
  errors: z.array(ApiError).optional(),
  result: z.unknown(),
  result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional() }).optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/** The envelope of any answer; null when the body is not Cloudflare's JSON. */
export function parseEnvelope(body: unknown): Envelope | null {
  const parsed = Envelope.safeParse(body);
  return parsed.success ? parsed.data : null;
}

const Verify = z.object({ id: z.string().optional(), status: z.string(), expires_on: z.string().optional() });

export interface TokenInfo {
  /** The token's id (not its value); null when it was accepted without the verify endpoint. */
  id: string | null;
  expiresOn: string | null;
}

/** The result of GET /user/tokens/verify. Throws a CloudflareError for a token that is not active. */
export function parseVerify(result: unknown): TokenInfo {
  const parsed = Verify.safeParse(result);
  if (!parsed.success) throw new CloudflareError("Cloudflare's answer was not what was expected.", "unexpected", 0);
  if (parsed.data.status !== "active") {
    throw new CloudflareError(`Cloudflare says this token is ${parsed.data.status}: create a new one.`, "invalid_token", 0);
  }
  return { id: parsed.data.id ?? null, expiresOn: parsed.data.expires_on ?? null };
}

const Zone = z.object({ id: z.string(), name: z.string() });

export function parseZones(result: unknown): CfZone[] {
  const parsed = z.array(Zone).safeParse(result);
  if (!parsed.success) throw new CloudflareError("Cloudflare's list of zones was not what was expected.", "unexpected", 0);
  return parsed.data.map((zone) => ({ id: zone.id, name: cleanHostname(zone.name) }));
}

const RecordShape = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string().optional(), proxied: z.boolean().optional(), ttl: z.number().optional() });

export function parseRecords(result: unknown): CfRecord[] {
  const parsed = z.array(RecordShape).safeParse(result);
  if (!parsed.success) throw new CloudflareError("Cloudflare's list of DNS records was not what was expected.", "unexpected", 0);
  return parsed.data.map((r) => ({ id: r.id, type: r.type.toUpperCase(), name: cleanHostname(r.name), content: r.content ?? "", proxied: r.proxied ?? false, ttl: r.ttl ?? 1 }));
}

export function parseRecord(result: unknown): CfRecord {
  const one = parseRecords([result])[0];
  if (!one) throw new CloudflareError("Cloudflare's DNS record was not what was expected.", "unexpected", 0);
  return one;
}

// ---- errors ----

export type CloudflareCall = "verify" | "zones" | "records" | "write";

/** What each kind of call needs, for the message that says what to change when Cloudflare refuses it. */
const NEEDS: Record<CloudflareCall, string> = {
  verify: "The token was not accepted.",
  zones: "The token cannot list zones: give it the permission Zone → Zone → Read.",
  records: "The token cannot read DNS records: give it the permission Zone → DNS → Edit on this zone.",
  write: "The token cannot change DNS records on this zone: give it the permission Zone → DNS → Edit, and include this zone in its resources.",
};

/** The error to raise for a Cloudflare answer that was not a success. `retryAfter` is the header's seconds, when given. */
export function explainFailure(status: number, apiErrors: { code?: number; message?: string }[], call: CloudflareCall, retryAfter?: number): CloudflareError {
  const codes = apiErrors.map((e) => e.code);
  // 6003 / 6111: the Authorization header is not a token Cloudflare can read; 1000: an invalid token. A 403 with 10000
  // ("Authentication error") is what a token gets for a zone or permission it does not have: that is `forbidden`.
  const authRejected = status === 401 || codes.some((c) => c === 6003 || c === 6111 || c === 1000);
  if (call === "verify" && (authRejected || status === 400 || status === 403)) {
    return new CloudflareError("Cloudflare did not accept this token. Check that you pasted all of it, and that it has not expired or been revoked.", "invalid_token", status);
  }
  if (status === 429) {
    const wait = retryAfter !== undefined && retryAfter > 0 ? ` Try again in ${retryAfter} seconds.` : " Try again in a minute.";
    return new CloudflareError(`Cloudflare's request limit was reached.${wait}`, "rate_limited", status);
  }
  if (authRejected && call !== "verify") {
    return new CloudflareError("Cloudflare no longer accepts the stored token: it was expired or revoked. Connect a new one in Settings → Integrations.", "invalid_token", status);
  }
  if (status === 403 || codes.includes(9109)) return new CloudflareError(NEEDS[call], "forbidden", status);
  if (status === 404) return new CloudflareError("Cloudflare does not know this zone or record any more.", "not_found", status);
  if (status >= 500) return new CloudflareError(`Cloudflare answered with status ${status}: its API is having trouble. Try again later.`, "unreachable", status);
  const detail = apiErrors.find((e) => e.message)?.message;
  return new CloudflareError(`Cloudflare refused the request (status ${status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`, "unexpected", status);
}

// ---- zones ----

/**
 * The zone a host name belongs to: the one with the longest name that the host equals or ends with, at a label boundary.
 * `notexample.com` is not in `example.com`; `a.eu.example.com` is in `eu.example.com` when both zones exist. Registry suffixes
 * such as co.uk are no special case: Cloudflare zones are registered domains (`example.co.uk`).
 */
export function zoneFor(hostname: string, zones: readonly CfZone[]): CfZone | null {
  const host = cleanHostname(hostname);
  let best: CfZone | null = null;
  for (const zone of zones) {
    const name = cleanHostname(zone.name);
    if ((host === name || host.endsWith(`.${name}`)) && (best === null || name.length > best.name.length)) best = zone;
  }
  return best;
}

// ---- records ----

export type DesiredType = "A" | "AAAA";

/** The records that compete for the name: a name holds one CNAME or addresses, and an address of the same family is the one to match. */
function competing(type: DesiredType, records: readonly CfRecord[], hostname: string): CfRecord[] {
  const name = cleanHostname(hostname);
  return records.filter((r) => r.name === name && (r.type === "CNAME" || r.type === type));
}

export type RecordPlan = { action: "none"; record: CfRecord } | { action: "create" } | { action: "conflict"; existing: CfRecord[] };

/**
 * What to do so that `hostname` points at `ip`: nothing when a record of the right type already has that content (its
 * proxied flag is not touched: it may be the operator's choice), create it when nothing competes, and otherwise report the
 * conflict. A record of the other family (an AAAA next to the A we want) is not a conflict.
 */
export function planRecord(hostname: string, family: IpFamily, ip: string, records: readonly CfRecord[]): RecordPlan {
  const type = recordType(family);
  const found = competing(type, records, hostname);
  const right = found.find((r) => r.type === type && sameIp(r.content, ip));
  if (right) return { action: "none", record: right };
  return found.length === 0 ? { action: "create" } : { action: "conflict", existing: found };
}

/** The old value in words, as the operator confirms it ("A 203.0.113.5"): the same text on the way out and back in. */
export function conflictValue(existing: readonly CfRecord[]): string {
  return existing
    .map((r) => `${r.type} ${r.content}`)
    .sort()
    .join(", ");
}

/** The record as shown: "A app.example.com -> 203.0.113.7, proxied". */
export function recordLine(type: string, hostname: string, content: string, proxied: boolean): string {
  return `${type} ${hostname} -> ${content}, ${proxied ? "proxied" : "DNS only"}`;
}
