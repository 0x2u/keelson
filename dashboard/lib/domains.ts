import "server-only";
import { deriveAddress, type AddressResult } from "@/lib/address-core";
import type { AgentClient } from "@/lib/agent";
import type { ProxyView } from "@/lib/agent-types";
import { createRecord, deleteRecord, listRecords, listZones, updateRecord } from "@/lib/cloudflare";
import { CloudflareError, zoneFor, type CfRecord, type CfZone } from "@/lib/cloudflare-core";
import { ensureDnsRecord, type DnsApi, type DnsResult } from "@/lib/dns-record-core";
import { fetchHttps, probeCertificate, resolveAll, resolveHost } from "@/lib/domain-probe";
import {
  assembleStatus,
  declaredHostnames,
  expectedOf,
  probeTarget,
  type CertProbe,
  type CloudflareFacts,
  type DomainStatus,
  type GetProbe,
  type ProxyFacts,
  type ResolveFacts,
} from "@/lib/domain-status-core";
import { cleanHostname, isHostname } from "@/lib/address-core";
import { cloudflareToken } from "@/lib/integrations";
import { describeSource, type ServerAddress } from "@/lib/address-core";
import type { DnsSetup, SetupAddress } from "@/lib/dns-record-core";
import type { ServerSummary } from "@/lib/servers";

/** The address a server's domains must point at: the override, the agent URL's IP, or what its host name resolves to. */
export function serverAddress(server: Pick<ServerSummary, "url" | "publicIp">): Promise<AddressResult> {
  return deriveAddress(server, resolveAll);
}

function setupAddress(result: AddressResult, url: string): SetupAddress {
  if (!result.ok) return { ok: false, error: result.error };
  const a: ServerAddress = result.address;
  return { ok: true, ip: a.ip, type: a.family === 4 ? "A" : "AAAA", source: describeSource(a, url), private: a.private };
}

/**
 * What the wizard shows for a domain's DNS: the server's address, whether Cloudflare is connected and which zones it sees.
 * Asks nothing of Cloudflare when the server cannot serve domains (`offered` false) or no token is connected.
 */
export async function loadDnsSetup(server: Pick<ServerSummary, "url" | "publicIp">, offered: boolean): Promise<DnsSetup> {
  const address = setupAddress(await serverAddress(server), server.url);
  const token = offered ? cloudflareToken() : null;
  if (token === null) return { connected: false, zones: [], zonesError: null, address };
  try {
    const { zones } = await listZones(token);
    return { connected: true, zones: zones.map((z) => z.name), zonesError: null, address };
  } catch (err) {
    return { connected: true, zones: [], zonesError: err instanceof CloudflareError ? err.message : "Cloudflare could not be asked for its zones.", address };
  }
}

/** The connected token's API. */
function dnsApi(token: string): DnsApi {
  return {
    listRecords: (zone, name) => listRecords(token, zone, name),
    createRecord: (zone, record) => createRecord(token, zone, record),
    updateRecord: (zone, id, record) => updateRecord(token, zone, id, record),
    deleteRecord: (zone, id) => deleteRecord(token, zone, id),
  };
}

export interface EnsureOptions {
  hostname: string;
  address: AddressResult;
  proxied: boolean;
  confirmReplace?: string;
  allowPrivate?: boolean;
}

/** Points a host name at the server at Cloudflare (idempotent, nothing overwritten unconfirmed). See ensureDnsRecord. */
export async function ensureDns(options: EnsureOptions, audit: (event: string, detail: string) => void | Promise<void>): Promise<DnsResult> {
  const token = cloudflareToken();
  if (token === null) return { kind: "not_connected", message: "Cloudflare is not connected: connect it in Settings → Integrations, or create the record yourself." };
  if (!options.address.ok) return { kind: "failed", message: options.address.error };
  return ensureDnsRecord(
    { hostname: options.hostname, address: options.address.address, proxied: options.proxied, confirmReplace: options.confirmReplace, allowPrivate: options.allowPrivate },
    { zones: async () => (await listZones(token)).zones, api: dnsApi(token), audit },
  );
}

// ---- status ----

/** What a check reaches out for: the system resolver, Cloudflare, the server's port 443 and the host name over HTTPS. Replaceable in tests. */
export interface Probes {
  resolve(hostname: string): Promise<ResolveFacts>;
  /** The zone's records for the name, or null when no token is connected. */
  cloudflare(hostname: string): Promise<CloudflareFacts>;
  cert(ip: string, hostname: string): Promise<CertProbe>;
  get(hostname: string): Promise<GetProbe>;
  now(): number;
}

async function cloudflareFacts(hostname: string): Promise<CloudflareFacts> {
  const token = cloudflareToken();
  if (token === null) return { state: "off" };
  try {
    const zone: CfZone | null = zoneFor(hostname, (await listZones(token)).zones);
    if (zone === null) return { state: "no_zone" };
    const records: CfRecord[] = await listRecords(token, zone.id, hostname);
    return { state: "ok", zone: zone.name, records };
  } catch (err) {
    return { state: "error", message: err instanceof CloudflareError ? err.message : "Cloudflare could not be read." };
  }
}

export const realProbes: Probes = { resolve: resolveHost, cloudflare: cloudflareFacts, cert: (ip, host) => probeCertificate(ip, host), get: (host) => fetchHttps(host), now: Date.now };

const NOT_PROBED: ResolveFacts = { ok: false, reason: "none" };

async function proxyFacts(agent: Pick<AgentClient, "proxy">): Promise<{ facts: ProxyFacts; view: ProxyView | null }> {
  try {
    const view = await agent.proxy();
    return view === null ? { facts: { state: "none" }, view: null } : { facts: { state: "ok", view }, view };
  } catch (err) {
    return { facts: { state: "error", message: err instanceof Error ? err.message : "the agent did not answer" }, view: null };
  }
}

/**
 * The three checks for a host name on a server. Only a host name the agent declares (its apps' and sites' domains) is
 * ever resolved, asked about at Cloudflare or probed, and the probe only connects to the server's own address: anything else
 * is answered without touching the network, whatever was asked for.
 */
export async function checkDomain(server: Pick<ServerSummary, "url" | "publicIp">, agent: Pick<AgentClient, "proxy">, hostname: string, probes: Probes = realProbes): Promise<DomainStatus> {
  const host = cleanHostname(hostname);
  const [address, proxy] = await Promise.all([serverAddress(server), proxyFacts(agent)]);
  const expected = expectedOf(address.ok ? address.address : null);
  const declared = declaredHostnames(proxy.view);
  const target = probeTarget(host, declared, expected);
  const base = { hostname: host, now: probes.now(), expected, proxy: proxy.facts };
  // An IP literal is never a host to look up, even if an agent declares one.
  if (!isHostname(host) || !declared.has(host)) return assembleStatus({ ...base, declared: false, resolved: NOT_PROBED, cloudflare: { state: "off" }, cert: null, get: null });
  const [resolved, cloudflare, cert, get] = await Promise.all([
    probes.resolve(host),
    probes.cloudflare(host),
    target.ok ? probes.cert(target.ip, target.hostname) : Promise.resolve(null),
    target.ok ? probes.get(target.hostname) : Promise.resolve(null),
  ]);
  return assembleStatus({ ...base, declared: true, resolved, cloudflare, cert, get });
}
