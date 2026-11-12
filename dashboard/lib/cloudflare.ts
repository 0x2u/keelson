import "server-only";
import {
  CloudflareError,
  explainFailure,
  parseEnvelope,
  parseRecord,
  parseRecords,
  parseVerify,
  parseZones,
  type CfRecord,
  type CfZone,
  type CloudflareCall,
  type TokenInfo,
} from "@/lib/cloudflare-core";

/** Fixed, like GitHub's: the token only ever goes to this address. */
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 8000;
const ZONES_PER_PAGE = 50;
/** A token that sees more zones than this is cut off, and says so. */
const MAX_PAGES = 20;

interface Called {
  result: unknown;
  totalPages: number;
}

/**
 * One call to the API. Redirects are never followed (the Authorization header would go with them), nothing is cached, and
 * whatever goes wrong is a CloudflareError whose message is fit to show: the token is not in it, nor is a raw body.
 */
async function call(token: string, method: string, path: string, what: CloudflareCall, query: Record<string, string> = {}, body?: unknown): Promise<Called> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "keelson-dashboard",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CloudflareError("Could not reach api.cloudflare.com. Check this server's internet access.", "unreachable", 0);
  }
  const envelope = parseEnvelope(await res.json().catch(() => null));
  if (res.ok && envelope === null) {
    throw new CloudflareError("Cloudflare's answer was not what was expected: something between this server and the internet may be answering for api.cloudflare.com.", "unexpected", res.status);
  }
  if (!res.ok || envelope === null || envelope.success === false) {
    const retry = Number(res.headers.get("retry-after"));
    throw explainFailure(res.status, envelope?.errors ?? [], what, Number.isFinite(retry) ? retry : undefined);
  }
  return { result: envelope.result, totalPages: envelope.result_info?.total_pages ?? 1 };
}

/**
 * Whether the token works: Cloudflare's own check of a user token, and when it does not know the token (an account-owned one
 * is verified elsewhere), whether it can list zones. Throws a CloudflareError that says what to fix.
 */
export async function verifyToken(token: string): Promise<TokenInfo> {
  try {
    return parseVerify((await call(token, "GET", "/user/tokens/verify", "verify")).result);
  } catch (err) {
    if (!(err instanceof CloudflareError) || err.code !== "invalid_token" || err.status === 0) throw err;
    // Not a user token (or not a token at all): listing a zone is the proof that it is usable.
    const zones = await listZones(token).catch(() => null);
    if (zones === null) throw err;
    return { id: null, expiresOn: null };
  }
}

export interface ZoneList {
  zones: CfZone[];
  /** More zones exist than were read. */
  truncated: boolean;
}

/** The zones the token can see, all pages (up to a thousand). */
export async function listZones(token: string): Promise<ZoneList> {
  const zones: CfZone[] = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    const out = await call(token, "GET", "/zones", "zones", { page: String(page), per_page: String(ZONES_PER_PAGE) });
    totalPages = out.totalPages;
    zones.push(...parseZones(out.result));
  }
  return { zones, truncated: totalPages > MAX_PAGES };
}

/** The A, AAAA and CNAME records named exactly this in the zone (other types are not our business). */
export async function listRecords(token: string, zoneId: string, name: string): Promise<CfRecord[]> {
  const out: CfRecord[] = [];
  for (const type of ["A", "AAAA", "CNAME"]) {
    const page = await call(token, "GET", `/zones/${encodeURIComponent(zoneId)}/dns_records`, "records", { name, type, per_page: "100" });
    out.push(...parseRecords(page.result));
  }
  return out;
}

export interface RecordWrite {
  type: "A" | "AAAA";
  name: string;
  content: string;
  proxied: boolean;
}

/** TTL 1 is Cloudflare's "automatic". */
const body = (r: RecordWrite) => ({ type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: 1 });

export async function createRecord(token: string, zoneId: string, record: RecordWrite): Promise<CfRecord> {
  return parseRecord((await call(token, "POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, "write", {}, body(record))).result);
}

export async function updateRecord(token: string, zoneId: string, id: string, record: RecordWrite): Promise<CfRecord> {
  return parseRecord((await call(token, "PUT", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, "write", {}, body(record))).result);
}

export async function deleteRecord(token: string, zoneId: string, id: string): Promise<void> {
  await call(token, "DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, "write");
}
