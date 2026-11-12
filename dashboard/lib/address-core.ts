/**
 * IP addresses and host names, as far as the domain features need them: a canonical form to compare, why an address
 * cannot be put in a public DNS record, which address is a server's, and whether an address belongs to Cloudflare's
 * network. No network and no database: the resolver is passed in.
 */

export type IpFamily = 4 | 6;

/** Dotted decimal, four parts of 0 to 255 without leading zeros (so 1.2.3.04 is not an address). */
function v4Bytes(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b, i) => b <= 255 && String(b) === m[i + 1]) ? bytes : null;
}

/** The eight 16-bit groups of an IPv6 address (:: expanded, a dotted IPv4 tail converted); null when the text is not one. */
function v6Groups(text: string): number[] | null {
  let t = text.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(t)) return null;
  const tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (tail) {
    const b = v4Bytes(tail[1]!);
    if (!b) return null;
    t = `${t.slice(0, -tail[1]!.length)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const parts = t.split("::");
  if (parts.length > 2) return null;
  const side = (s: string | undefined): string[] => (s === undefined || s === "" ? [] : s.split(":"));
  const head = side(parts[0]);
  const rest = parts.length === 2 ? side(parts[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null; // "::" stands for at least one group
  return [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
}

/** RFC 5952: lowercase, leading zeros dropped, the longest run of two or more zero groups written as "::". */
function formatV6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

export interface Ip {
  /** Canonical text: IPv4 as dotted decimal, IPv6 as RFC 5952. */
  text: string;
  family: IpFamily;
}

/** An IP address in canonical form, or null when the text is not one (a zone id, a port, a CIDR, a host name). */
export function parseIp(raw: string): Ip | null {
  const text = raw.trim();
  const v4 = v4Bytes(text);
  if (v4) return { text: v4.join("."), family: 4 };
  const v6 = v6Groups(text);
  return v6 ? { text: formatV6(v6), family: 6 } : null;
}

/** Whether two address texts are the same address, whatever their spelling. False when either is not an address. */
export function sameIp(a: string, b: string): boolean {
  const x = parseIp(a);
  const y = parseIp(b);
  return x !== null && y !== null && x.text === y.text;
}

function privateV4(b: number[]): string | null {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return "an unspecified address";
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return "a private network address";
  if (a === 127) return "a loopback address";
  if (a === 169 && c === 254) return "a link-local address";
  if (a === 100 && c >= 64 && c <= 127) return "a shared address (100.64.0.0/10, used by Tailscale and carrier-grade NAT)";
  if (a >= 224) return "a multicast or reserved address";
  return null;
}

/**
 * Why this address cannot be put in a public DNS record: private, loopback, link-local, shared (Tailscale), unspecified,
 * multicast or reserved. Null for a routable address, and for text that is not an address.
 */
export function privateReason(raw: string): string | null {
  const ip = parseIp(raw);
  if (!ip) return null;
  if (ip.family === 4) return privateV4(v4Bytes(ip.text)!);
  const g = v6Groups(ip.text)!;
  if (g.every((x) => x === 0)) return "an unspecified address";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "a loopback address";
  // ::ffff:a.b.c.d is IPv4 in IPv6 clothes.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  if ((g[0]! & 0xffc0) === 0xfe80) return "a link-local address";
  if ((g[0]! & 0xfe00) === 0xfc00) return "a private (unique local) address";
  if ((g[0]! & 0xff00) === 0xff00) return "a multicast address";
  return null;
}

// ---- Cloudflare's network ----

/** https://www.cloudflare.com/ips-v4 and /ips-v6. A proxied record answers with these, not with the origin's address. */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

function v4Number(b: number[]): number {
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}

function inV4(ip: number[], cidr: string): boolean {
  const [base, bits] = cidr.split("/") as [string, string];
  const mask = bits === "0" ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((v4Number(ip) & mask) >>> 0) === ((v4Number(v4Bytes(base)!) & mask) >>> 0);
}

function inV6(groups: number[], cidr: string): boolean {
  const [base, bits] = cidr.split("/") as [string, string];
  const b = v6Groups(base)!;
  let left = Number(bits);
  for (let i = 0; i < 8 && left > 0; i++, left -= 16) {
    const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
    if ((groups[i]! & mask) !== (b[i]! & mask)) return false;
  }
  return true;
}

/** Whether the address is one of Cloudflare's: a name that resolves to these is proxied by Cloudflare. */
export function isCloudflareAddress(raw: string): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  if (ip.family === 4) {
    const bytes = v4Bytes(ip.text)!;
    return CLOUDFLARE_V4.some((c) => inV4(bytes, c));
  }
  const groups = v6Groups(ip.text)!;
  return CLOUDFLARE_V6.some((c) => inV6(groups, c));
}

// ---- host names ----

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name as DNS and a certificate understand it: at least two labels, no IP literal, no wildcard, at most 253 characters. */
export function isHostname(text: string): boolean {
  if (text.length > 253 || text !== text.toLowerCase()) return false;
  const labels = text.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]!); // 1.2.3.4 and 1.2.3.04 are addresses, not names
}

/** The host name in lower case without a trailing dot, for comparing; the text is not otherwise checked. */
export function cleanHostname(text: string): string {
  return text.trim().toLowerCase().replace(/\.$/, "");
}

// ---- a server's public address ----

export type AddressSource = "override" | "agent-url" | "resolved";

export interface ServerAddress {
  /** Canonical text. */
  ip: string;
  family: IpFamily;
  source: AddressSource;
  /** Why this address cannot be put in a public DNS record, or null when it can. */
  private: string | null;
}

export type AddressResult = { ok: true; address: ServerAddress } | { ok: false; error: string };

/** The record type that points a name at an address: A for IPv4, AAAA for IPv6. */
export function recordType(family: IpFamily): "A" | "AAAA" {
  return family === 4 ? "A" : "AAAA";
}

function describe(ip: Ip, source: AddressSource): ServerAddress {
  return { ip: ip.text, family: ip.family, source, private: privateReason(ip.text) };
}

/** The host of an agent URL with an IPv6 literal's brackets removed; null when the URL does not parse. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * The address the server's domains must point at. The explicit override wins; otherwise the host of the agent's URL
 * when it is an IP address, or what that host name resolves to (IPv4 first). `resolve` is the system resolver.
 */
export async function deriveAddress(server: { url: string; publicIp: string | null }, resolve: (host: string) => Promise<string[]>): Promise<AddressResult> {
  if (server.publicIp !== null && server.publicIp.trim() !== "") {
    const ip = parseIp(server.publicIp);
    if (!ip) return { ok: false, error: `The public address set for this server (${server.publicIp}) is not an IP address.` };
    return { ok: true, address: describe(ip, "override") };
  }
  if (server.url === "") return { ok: false, error: "This server connects out to the dashboard, so it has no URL to read its address from. Set the server's public address in its settings." };
  const host = urlHost(server.url);
  if (host === null) return { ok: false, error: "The agent's URL could not be read." };
  const literal = parseIp(host);
  if (literal) return { ok: true, address: describe(literal, "agent-url") };
  let found: string[];
  try {
    found = await resolve(host);
  } catch {
    return { ok: false, error: `The agent's host name (${host}) did not resolve. Set the server's public address in its settings.` };
  }
  const ips = found.map(parseIp).filter((x): x is Ip => x !== null);
  const pick = ips.find((i) => i.family === 4) ?? ips[0];
  if (!pick) return { ok: false, error: `The agent's host name (${host}) did not resolve to an address. Set the server's public address in its settings.` };
  return { ok: true, address: describe(pick, "resolved") };
}

/** Where the address came from, for the operator. */
export function describeSource(address: ServerAddress, url: string): string {
  switch (address.source) {
    case "override":
      return "set in this server's settings";
    case "agent-url":
      return "the host of the agent's URL";
    default:
      return `what ${urlHost(url) ?? "the agent's host name"} resolves to`;
  }
}

/** The sentence that refuses a private address for a public record, and says what to do. */
export function privateMessage(address: Pick<ServerAddress, "ip" | "private">): string {
  return `${address.ip} is ${address.private}: a public DNS record pointing at it would not reach this server from the internet. Set the server's public address in its settings, or confirm that you want it anyway (a private network or split-horizon DNS).`;
}

/** What the server settings form accepts for the public address: empty (derive it) or an IP address. Returns the canonical text, "" or null for an invalid one. */
export function normalizePublicIp(text: string): string | null {
  const t = text.trim();
  if (t === "") return "";
  return parseIp(t)?.text ?? null;
}
