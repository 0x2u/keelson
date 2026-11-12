/**
 * Makes a host name point at a server, at Cloudflare, and no more than that: the record is created when nothing is there,
 * left alone when it is already right, and never overwritten without the operator confirming the old value by name. The
 * zones, the API and the audit are passed in; nothing here reads a token.
 */

import { isHostname, privateMessage, recordType, type ServerAddress } from "@/lib/address-core";
import {
  CloudflareError,
  conflictValue,
  planRecord,
  recordLine,
  zoneFor,
  type CfRecord,
  type CfZone,
  type RecordPlan,
} from "@/lib/cloudflare-core";

export interface DnsRequest {
  hostname: string;
  address: Pick<ServerAddress, "ip" | "family" | "private">;
  /** Proxied through Cloudflare (hides the origin, works with HTTP-01) or DNS only (the record exposes the address). */
  proxied: boolean;
  /** The old value the operator confirmed replacing, exactly as the conflict reported it. */
  confirmReplace?: string;
  /** The operator confirmed putting a private address in the record (a private network or split-horizon DNS). */
  allowPrivate?: boolean;
}

export interface DnsApi {
  listRecords(zoneId: string, name: string): Promise<CfRecord[]>;
  createRecord(zoneId: string, record: { type: "A" | "AAAA"; name: string; content: string; proxied: boolean }): Promise<CfRecord>;
  updateRecord(zoneId: string, id: string, record: { type: "A" | "AAAA"; name: string; content: string; proxied: boolean }): Promise<CfRecord>;
  deleteRecord(zoneId: string, id: string): Promise<void>;
}

export interface DnsDeps {
  zones(): Promise<CfZone[]>;
  api: DnsApi;
  audit(event: string, detail: string): void | Promise<void>;
}

export interface RecordFacts {
  type: string;
  content: string;
  proxied: boolean;
}

export type DnsResult =
  | { kind: "exists"; zone: string; record: RecordFacts }
  | { kind: "created"; zone: string; record: RecordFacts }
  | { kind: "replaced"; zone: string; record: RecordFacts; old: string }
  /** Something else is there: nothing was changed. Confirm by sending `confirm` back as `confirmReplace`. */
  | { kind: "conflict"; zone: string; existing: RecordFacts[]; confirm: string }
  | { kind: "private"; ip: string; message: string }
  | { kind: "not_connected"; message: string }
  | { kind: "no_zone"; message: string }
  | { kind: "failed"; message: string };

const facts = (r: CfRecord): RecordFacts => ({ type: r.type, content: r.content, proxied: r.proxied });

/** What the result says, in one sentence, for a step line or a toast. */
export function describeDns(result: DnsResult, hostname: string): string {
  switch (result.kind) {
    case "exists":
      return `${recordLine(result.record.type, hostname, result.record.content, result.record.proxied)} already exists at Cloudflare: nothing changed.`;
    case "created":
      return `Created ${recordLine(result.record.type, hostname, result.record.content, result.record.proxied)} (zone ${result.zone}).`;
    case "replaced":
      return `Replaced ${result.old} with ${recordLine(result.record.type, hostname, result.record.content, result.record.proxied)} (zone ${result.zone}).`;
    case "conflict":
      return `${hostname} already has ${result.confirm} at Cloudflare. It was not changed: confirm the replacement to overwrite it.`;
    default:
      return result.message;
  }
}

async function replace(zone: CfZone, hostname: string, existing: CfRecord[], want: { type: "A" | "AAAA"; content: string; proxied: boolean }, deps: DnsDeps): Promise<CfRecord> {
  const record = { type: want.type, name: hostname, content: want.content, proxied: want.proxied };
  // A record of the type we want is updated in place; a CNAME cannot sit next to an address, so it goes first.
  const keep = existing.find((r) => r.type === want.type);
  for (const r of existing) if (r !== keep) await deps.api.deleteRecord(zone.id, r.id);
  return keep ? deps.api.updateRecord(zone.id, keep.id, record) : deps.api.createRecord(zone.id, record);
}

/**
 * Idempotent. Refuses a private address (unless confirmed), finds the zone, and then: an existing record that is right is
 * left as it is; none is created (`proxied` as asked, TTL automatic); a different one is reported, and replaced only when
 * `confirmReplace` equals what the conflict said was there. Every change is audited with the old and the new value.
 */
export async function ensureDnsRecord(req: DnsRequest, deps: DnsDeps): Promise<DnsResult> {
  const hostname = req.hostname.trim().toLowerCase();
  if (!isHostname(hostname)) return { kind: "failed", message: `${req.hostname.trim() || "That"} is not a valid host name.` };
  if (req.address.private !== null && req.allowPrivate !== true) {
    return { kind: "private", ip: req.address.ip, message: privateMessage(req.address) };
  }
  const type = recordType(req.address.family);
  try {
    const zone = zoneFor(hostname, await deps.zones());
    if (zone === null) {
      return { kind: "no_zone", message: `No Cloudflare zone covers ${hostname}: the connected token does not see its domain. Create the record where the domain's DNS is hosted, or add the zone to the token's resources.` };
    }
    const existing = await deps.api.listRecords(zone.id, hostname);
    const plan: RecordPlan = planRecord(hostname, req.address.family, req.address.ip, existing);
    const want = { type, content: req.address.ip, proxied: req.proxied };
    const where = `${hostname} (zone ${zone.name})`;
    const privateNote = req.address.private !== null ? " [private address confirmed]" : "";

    if (plan.action === "none") return { kind: "exists", zone: zone.name, record: facts(plan.record) };
    if (plan.action === "create") {
      const made = await deps.api.createRecord(zone.id, { ...want, name: hostname });
      await deps.audit("dns_record_created", `${where}: ${recordLine(want.type, hostname, want.content, want.proxied)}${privateNote}`);
      return { kind: "created", zone: zone.name, record: facts(made) };
    }
    const old = conflictValue(plan.existing);
    if (req.confirmReplace !== old) return { kind: "conflict", zone: zone.name, existing: plan.existing.map(facts), confirm: old };
    const made = await replace(zone, hostname, plan.existing, want, deps);
    await deps.audit("dns_record_replaced", `${where}: was ${old}, now ${recordLine(want.type, hostname, want.content, want.proxied)}${privateNote}`);
    return { kind: "replaced", zone: zone.name, record: facts(made), old };
  } catch (err) {
    if (err instanceof CloudflareError) return { kind: "failed", message: err.message };
    return { kind: "failed", message: "Something went wrong talking to Cloudflare." };
  }
}

// ---- the plan shown before anything is created ----

/** What the wizard knows about the server's address, in a form the browser can hold. */
export type SetupAddress =
  | { ok: true; ip: string; type: "A" | "AAAA"; /** Where it came from, in words. */ source: string; /** Why a public record cannot hold it, or null. */ private: string | null }
  | { ok: false; error: string };

/** What the wizard knows about Cloudflare. */
export interface DnsSetup {
  connected: boolean;
  /** The names of the zones the token sees; empty when not connected or when they could not be listed. */
  zones: string[];
  /** Why the zones could not be listed, when they could not. */
  zonesError: string | null;
  address: SetupAddress;
}

export type DnsPlan =
  /** Keelson creates the record at Cloudflare. */
  | { kind: "cloudflare"; zone: string; type: "A" | "AAAA"; ip: string; privateReason: string | null }
  /** The operator creates it: `record` holds the exact values when the address is known. */
  | { kind: "manual"; why: "not_connected" | "no_zone" | "zones_error" | "no_address"; message: string; record: { type: "A" | "AAAA"; name: string; content: string } | null };

/** What will happen for a host name: created at Cloudflare when connected and the zone is there, otherwise the exact record to create by hand. */
export function planWizard(hostname: string, setup: DnsSetup): DnsPlan {
  const host = hostname.trim().toLowerCase();
  if (!setup.address.ok) return { kind: "manual", why: "no_address", message: setup.address.error, record: null };
  const record = { type: setup.address.type, name: host, content: setup.address.ip };
  if (!setup.connected) {
    return { kind: "manual", why: "not_connected", message: "Cloudflare is not connected, so Keelson cannot create the record.", record };
  }
  if (setup.zonesError !== null) return { kind: "manual", why: "zones_error", message: setup.zonesError, record };
  const zone = zoneFor(host, setup.zones.map((name) => ({ id: "", name })));
  if (zone === null) return { kind: "manual", why: "no_zone", message: `No zone of the connected Cloudflare account covers ${host}: its DNS is hosted somewhere else.`, record };
  return { kind: "cloudflare", zone: zone.name, type: setup.address.type, ip: setup.address.ip, privateReason: setup.address.private };
}

/** The step line when the operator creates the record: the exact values, or why they cannot be given. */
export function manualMessage(hostname: string, address: Pick<ServerAddress, "ip" | "family"> | null): string {
  if (address === null) return "Not created by Keelson, and the server's public address is not known: set it in the server's settings, then create the record yourself.";
  return `Not created by Keelson. Create ${recordType(address.family)} ${hostname} -> ${address.ip} at your DNS provider yourself.`;
}
