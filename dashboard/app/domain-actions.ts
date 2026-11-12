"use server";

import { revalidatePath } from "next/cache";
import { agentFor } from "@/lib/agent";
import { audit } from "@/lib/auth/store";
import { confirmPassword } from "@/lib/auth/confirm";
import { cleanHostname, isHostname } from "@/lib/address-core";
import { listZones, verifyToken } from "@/lib/cloudflare";
import { CloudflareError } from "@/lib/cloudflare-core";
import { describeDns, type DnsResult } from "@/lib/dns-record-core";
import type { DomainStatus } from "@/lib/domain-status-core";
import { declaredHostnames } from "@/lib/domain-status-core";
import { checkDomain, ensureDns, serverAddress } from "@/lib/domains";
import { removeCloudflare, saveCloudflare } from "@/lib/integrations";
import { getCredentials } from "@/lib/servers";
import { clientInfo, requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import { dnsRecord } from "@/lib/step-up-core";

export interface CloudflareState {
  error?: string;
  ok?: boolean;
}

const TOKEN_MAX = 255;

/**
 * Connects (or replaces) the Cloudflare token: after the password again, and only once Cloudflare has accepted the token and
 * shown that it can list zones. The token is write-only: it is never returned, shown, audited or logged.
 */
export async function connectCloudflareAction(_prev: CloudflareState, form: FormData): Promise<CloudflareState> {
  await requireSession();
  const rejected = await confirmPassword(form);
  if (rejected) return { error: rejected };
  const raw = form.get("token");
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token === "") return { error: "Paste the API token." };
  if (token.length > TOKEN_MAX || /\s/.test(token)) return { error: "That does not look like a Cloudflare API token." };
  let zones: number;
  let info;
  try {
    info = await verifyToken(token);
    zones = (await listZones(token)).zones.length;
  } catch (err) {
    return { error: err instanceof CloudflareError ? err.message : "Something went wrong asking Cloudflare. Try again." };
  }
  if (zones === 0) return { error: "The token is valid but sees no zone: give it Zone → Zone → Read and Zone → DNS → Edit on the domains you use." };
  saveCloudflare(token, { tokenId: info.id, expiresOn: info.expiresOn });
  audit("cloudflare_connected", `${zones} zone(s)${info.id ? `, token ${info.id}` : ""}`, (await clientInfo()).ip);
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Removes the stored token (after the password again). The DNS records it created stay where they are. */
export async function disconnectCloudflareAction(_prev: CloudflareState, form: FormData): Promise<CloudflareState> {
  await requireSession();
  const rejected = await confirmPassword(form);
  if (rejected) return { error: rejected };
  removeCloudflare();
  audit("cloudflare_disconnected", undefined, (await clientInfo()).ip);
  revalidatePath("/", "layout");
  return { ok: true };
}

export type DomainCheck = { ok: true; status: DomainStatus } | { ok: false; error: string };

/** Runs the three checks for one host name of a server. Only hosts the agent declares are ever probed. */
export async function checkDomainAction(serverId: string, hostname: string): Promise<DomainCheck> {
  await requireSession();
  const server = getCredentials(serverId);
  if (!server) return { ok: false, error: "Unknown server." };
  const host = cleanHostname(hostname);
  if (!isHostname(host)) return { ok: false, error: "That is not a host name." };
  return { ok: true, status: await checkDomain(server, agentFor(server), host) };
}

export interface DnsOptions {
  proxied: boolean;
  /** The old value, as the conflict reported it, to replace it. */
  confirmReplace?: string;
  /** Put a private address in the record anyway (a private network or split-horizon DNS). */
  allowPrivate?: boolean;
}

export interface DnsActionResult {
  result: DnsResult;
  /** The sentence for the operator. */
  message: string;
}

/**
 * Points a host name at the server at Cloudflare. Nothing is overwritten without `confirmReplace`; see ensureDnsRecord.
 *
 * The rule for the unlock (lib/step-up-core.ts `dnsRecord`): a record for a host name the server's agent declares and that
 * does not exist yet is day-to-day work (declaring the name needed the unlock already); replacing a record (`confirmReplace`)
 * and any host name the agent does not declare need it, because the dashboard's Cloudflare token reaches every zone of the
 * account. When the agent cannot say what it declares, nothing is declared.
 */
export async function ensureDnsAction(serverId: string, hostname: string, options: DnsOptions): Promise<DnsActionResult> {
  await requireSession();
  const host = cleanHostname(hostname);
  const server = getCredentials(serverId);
  if (!server) return { result: { kind: "failed", message: "Unknown server." }, message: "Unknown server." };
  let declared = false;
  try {
    declared = declaredHostnames((await agentFor(server).proxy()) ?? null).has(host);
  } catch {
    /* an agent that does not answer declares nothing */
  }
  const replacing = typeof options.confirmReplace === "string" && options.confirmReplace !== "";
  const locked = await stepUpError(dnsRecord(host, { declared, replacing }), `DNS record for ${host}`);
  if (locked) return { result: { kind: "failed", message: locked }, message: locked };
  const result: DnsResult = await ensureDns(
    { hostname: host, address: await serverAddress(server), proxied: options.proxied !== false, confirmReplace: options.confirmReplace, allowPrivate: options.allowPrivate === true },
    async (event, detail) => audit(event, `${server.name}: ${detail}`, (await clientInfo()).ip),
  );
  if (result.kind === "created" || result.kind === "replaced") revalidatePath(`/servers/${serverId}`, "layout");
  return { result, message: describeDns(result, host) };
}
