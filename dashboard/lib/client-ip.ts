import { isIP } from "node:net";
import { clientIpHeader, trustedHops, trustProxy } from "@/lib/env";

export interface ClientIpConfig {
  trustProxy: boolean;
  /** Reverse proxies in front of the dashboard: the client is that many entries from the right of X-Forwarded-For. */
  hops: number;
  /** A header the trusted proxy sets to the client's address (lower case); wins over X-Forwarded-For. */
  header: string | null;
}

/** The address a proxy wrote, without a port or brackets, as a plain IP; null when it is not one. */
export function normaliseIp(raw: string): string | null {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  value = value.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1");
  return isIP(value) === 0 ? null : value.toLowerCase();
}

/**
 * Who is calling, from the headers of a request.
 *
 * - A configured header (CF-Connecting-IP, X-Real-IP) is the address, when it holds one.
 * - Otherwise, behind a trusted proxy, X-Forwarded-For is read from the RIGHT: every proxy appends the address it saw, so the
 *   entry `hops` places from the end is the one the outermost trusted proxy recorded. Entries to its left were written by
 *   the client (or by proxies outside the trust boundary) and are never used: the leftmost entry is attacker-controlled.
 * - "local" when clients cannot be told apart (no trusted proxy); "unknown" when the header is missing, too short for the
 *   configured number of hops, or does not hold an address.
 *
 * The allowlist, the sign-in throttle, the audit log and the API-token throttle all go through here.
 */
export function clientIpFrom(headers: Pick<Headers, "get">, config: ClientIpConfig): string {
  if (config.header !== null) return normaliseIp(headers.get(config.header) ?? "") ?? "unknown";
  if (!config.trustProxy) return "local";
  const entries = (headers.get("x-forwarded-for") ?? "").split(",");
  const entry = entries.length >= config.hops ? entries[entries.length - config.hops] : undefined;
  return (entry !== undefined ? normaliseIp(entry) : null) ?? "unknown";
}

/** The configuration from the environment; read per call so a change of variables in tests (or a restart) is seen. */
export function clientIpConfig(): ClientIpConfig {
  const header = clientIpHeader();
  const proxied = trustProxy();
  return { trustProxy: proxied, hops: proxied ? trustedHops() : 1, header };
}

/** Whether the dashboard can tell clients apart at all (a trusted proxy or a named header): the allowlist needs it. */
export function clientIpKnowable(config: ClientIpConfig = clientIpConfig()): boolean {
  return config.trustProxy || config.header !== null;
}

/** Who is calling a route handler that has a Request in hand: the same rule as the sign-in (see clientInfo in lib/session.ts). */
export function requestIp(request: Request): string {
  return clientIpFrom(request.headers, clientIpConfig());
}

/**
 * The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail counts as two), or null when it is not one. `isIP` has
 * already said it is an address; this only expands it.
 */
function groupsOf(ip: string): number[] | null {
  let text = ip.split("%")[0];
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const rest = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The address a throttle counts under. An IPv4 address is its own bucket. An IPv6 client holds a whole /64 (any home or VPS
 * network), so a bucket per /128 would give it as many fresh counters as it likes: its bucket is the /64, written
 * `2001:db8:1:2::/64`. An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`, in either spelling) is the IPv4 address it carries.
 * "local", "unknown" and anything that is not an address are kept as they are: with no trusted proxy, everyone shares "local".
 */
export function addressBucket(address: string): string {
  if (isIP(address.split("%")[0]) !== 6) return address;
  const groups = groupsOf(address);
  if (groups === null) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** The prefixes of the throttle keys that hold an address after them (the sign-in's own keys are the bare address). */
const KEY_PREFIXES = ["relay:", "api:", "setup:"];

/** The key a throttle store counts under: `addressBucket` of the address in it, with its prefix kept. */
export function throttleBucket(key: string): string {
  const prefix = KEY_PREFIXES.find((p) => key.startsWith(p)) ?? "";
  return prefix + addressBucket(key.slice(prefix.length));
}
