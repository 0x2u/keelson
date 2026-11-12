/**
 * Is this domain working? Three checks in the order a visitor meets them: DNS (does the name lead to the server), the proxy
 * (does the agent's proxy route the name) and HTTPS (does the server answer for it with a certificate a browser accepts).
 * This file decides from facts gathered elsewhere and words the result; it opens no socket and reads no database.
 */

import { cleanHostname, isCloudflareAddress, isHostname, recordType, sameIp, type AddressSource, type ServerAddress } from "@/lib/address-core";
import type { CfRecord } from "@/lib/cloudflare-core";
import type { ProxyRoute, ProxyView } from "@/lib/agent-types";

export type CheckState = "ok" | "pending" | "failed" | "skipped";

export interface Check {
  state: CheckState;
  /** One line: what was found. */
  detail: string;
  /** One line: what to do about it. Absent when there is nothing to do. */
  next?: string;
  /** Working, but something needs a look soon (a certificate close to its end): shown as a warning, not a failure. */
  warn?: boolean;
}

/** The address the name must lead to, and the record that does it. */
export interface ExpectedAddress {
  type: "A" | "AAAA";
  ip: string;
  source: AddressSource;
}

export function expectedOf(address: ServerAddress | null): ExpectedAddress | null {
  return address === null ? null : { type: recordType(address.family), ip: address.ip, source: address.source };
}

export interface DomainStatus {
  hostname: string;
  /** When the checks ran (ms). */
  checkedAt: number;
  expected: ExpectedAddress | null;
  /** Whether a Cloudflare token is connected and the host's zone is one it sees. */
  cloudflare: "off" | "connected" | "no_zone" | "error";
  /** Why Cloudflare could not be read, when it could not. */
  cloudflareError?: string;
  dns: Check;
  proxy: Check;
  https: Check;
}

// ---- the facts ----

export type ResolveFacts = { ok: true; addresses: string[] } | { ok: false; reason: "none" | "error"; message?: string };

export type CloudflareFacts = { state: "off" } | { state: "error"; message: string } | { state: "no_zone" } | { state: "ok"; zone: string; records: CfRecord[] };

export type ProxyFacts = { state: "ok"; view: ProxyView } | { state: "none" } | { state: "error"; message: string };

/** What the TLS connection to the server's address, with the host name as SNI, found. */
export type CertProbe =
  | {
      kind: "cert";
      /** "Let's Encrypt R11": the issuer's organisation and common name. */
      issuer: string;
      /** The names the certificate is valid for. */
      names: string[];
      validFrom: number;
      validTo: number;
      /** The certificate is valid for the host name. */
      matches: boolean;
      /** The chain leads to a root the system trusts (and the name matches). */
      trusted: boolean;
      trustError?: string;
    }
  /** The handshake was refused (an alert): the proxy has no certificate for this name. */
  | { kind: "no_cert"; message: string }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "unreachable"; message: string };

/** An HTTPS GET of the host name through the normal path (DNS, and a certificate that must verify). */
export type GetProbe = { kind: "status"; status: number; location?: string } | { kind: "error"; message: string };

export interface StatusFacts {
  hostname: string;
  now: number;
  expected: ExpectedAddress | null;
  /** The host name is declared on the agent (in its proxy view): only then is anything probed. */
  declared: boolean;
  resolved: ResolveFacts;
  cloudflare: CloudflareFacts;
  proxy: ProxyFacts;
  cert: CertProbe | null;
  get: GetProbe | null;
}

// ---- the SSRF guard ----

/** Every host name the agent's proxy declares: its routes (apps and sites) and the apps waiting for their first route. */
export function declaredHostnames(view: ProxyView | null): Set<string> {
  const out = new Set<string>();
  if (view === null) return out;
  for (const route of view.routes) for (const d of route.domains) out.add(cleanHostname(d));
  for (const u of view.unrouted) for (const d of u.domains) out.add(cleanHostname(d));
  return out;
}

export interface HostEntry {
  hostname: string;
  /** What serves it: an app's name, or "site". */
  label: string;
}

/** The host names of the proxy view, each once, in the order the agent lists them; only one app's when `app` is given. Apps waiting for a route are included. */
export function hostsOf(view: ProxyView | null, app?: string): HostEntry[] {
  if (view === null) return [];
  const seen = new Set<string>();
  const out: HostEntry[] = [];
  const add = (domains: string[], label: string) => {
    for (const d of domains) {
      const hostname = cleanHostname(d);
      if (!seen.has(hostname)) {
        seen.add(hostname);
        out.push({ hostname, label });
      }
    }
  };
  for (const r of view.routes) if (app === undefined || r.app === app) add(r.domains, r.kind === "site" ? "site" : r.app);
  for (const u of view.unrouted) if (app === undefined || u.app === app) add(u.domains, u.app);
  return out;
}

export type ProbeTarget = { ok: true; hostname: string; ip: string } | { ok: false; reason: string };

/**
 * Where a probe may connect: the server's own address, for a host name the agent declares. An IP literal, a name the agent
 * does not serve and a missing address are refused, so the dashboard cannot be used to knock on arbitrary hosts.
 */
export function probeTarget(hostname: string, declared: ReadonlySet<string>, expected: ExpectedAddress | null): ProbeTarget {
  const host = cleanHostname(hostname);
  if (!isHostname(host)) return { ok: false, reason: "That is not a host name (IP addresses are never probed)." };
  if (!declared.has(host)) return { ok: false, reason: `${host} is not declared on this server's agent: only hosts of its apps and sites are checked.` };
  if (expected === null) return { ok: false, reason: "The server's public address is not known." };
  return { ok: true, hostname: host, ip: expected.ip };
}

// ---- DNS ----

const list = (records: readonly CfRecord[]): string => records.map((r) => `${r.type} ${r.content}`).join(", ");

/** The record at Cloudflare that already does the job (the right type and address), if any. */
export function rightRecord(hostname: string, expected: ExpectedAddress | null, cf: CloudflareFacts): CfRecord | null {
  if (expected === null || cf.state !== "ok") return null;
  return cf.records.find((r) => r.name === hostname && r.type === expected.type && sameIp(r.content, expected.ip)) ?? null;
}

export function evaluateDns(hostname: string, expected: ExpectedAddress | null, resolved: ResolveFacts, cf: CloudflareFacts): Check {
  if (expected === null) {
    return { state: "skipped", detail: "The server's public address is not known, so there is nothing to compare the name with.", next: "Set the public address in the server's settings." };
  }
  const want = `${expected.type} ${hostname} -> ${expected.ip}`;
  const addrs = resolved.ok ? resolved.addresses : [];
  const seen = addrs.length > 0 ? addrs.join(", ") : "";
  const relevant = cf.state === "ok" ? cf.records.filter((r) => r.name === hostname) : [];
  const right = rightRecord(hostname, expected, cf);

  if (right) {
    if (right.proxied) {
      if (addrs.length === 0) return { state: "pending", detail: `${want} exists at Cloudflare (proxied), but the name does not resolve yet.`, next: "Wait a minute and check again." };
      return { state: "ok", detail: `${want} at Cloudflare, proxied: visitors reach Cloudflare, which forwards to the server.` };
    }
    if (addrs.length === 0) {
      return { state: "pending", detail: `${want} exists at Cloudflare, but the name does not resolve from this dashboard yet.`, next: "A new record can take a few minutes to be visible. Check again shortly." };
    }
    if (addrs.some((a) => sameIp(a, expected.ip))) {
      const others = addrs.filter((a) => !sameIp(a, expected.ip));
      return { state: "ok", detail: `${hostname} resolves to the server (${expected.ip})${others.length > 0 ? ` and also to ${others.join(", ")}: make sure that is intended` : ""}.` };
    }
    return { state: "pending", detail: `Cloudflare has the right record, but resolvers still answer ${seen}.`, next: "That is a cached answer; it expires within the record's TTL. Check again shortly." };
  }

  // Only a CNAME may lead to the server by way of its target: a wrong address record is wrong whatever the resolver says
  // (it can be answered from a hosts file, a split-horizon zone or a cache).
  const cnameThatWorks = relevant.length > 0 && relevant.every((r) => r.type === "CNAME" && !r.proxied) && addrs.some((a) => sameIp(a, expected.ip));
  if (relevant.length > 0 && !cnameThatWorks) {
    return {
      state: "failed",
      detail: `Cloudflare has ${list(relevant)} for ${hostname}, not the server's ${expected.ip}.`,
      next: `Replace it with ${want} (Create the DNS record, then confirm the replacement), or correct it in Cloudflare.`,
    };
  }

  // Only the resolver speaks (no Cloudflare, or no record of ours there): what a visitor's resolver would get.
  if (addrs.length === 0) {
    const why = resolved.ok === false && resolved.reason === "error" ? ` (${resolved.message ?? "the resolver did not answer"})` : "";
    return { state: "pending", detail: `${hostname} does not resolve yet${why}.`, next: `Create ${want} at your DNS provider.` };
  }
  if (addrs.some((a) => sameIp(a, expected.ip))) {
    const others = addrs.filter((a) => !sameIp(a, expected.ip));
    return { state: "ok", detail: `${hostname} resolves to the server (${expected.ip})${others.length > 0 ? ` and also to ${others.join(", ")}: make sure that is intended` : ""}.` };
  }
  if (addrs.every(isCloudflareAddress)) {
    return {
      state: "ok",
      detail: `${hostname} resolves to Cloudflare's network (proxied). Where the record points cannot be read without a Cloudflare connection; the HTTPS check below tells whether the server answers.`,
      next: cf.state === "off" ? "Connect Cloudflare to check the record itself." : undefined,
    };
  }
  return { state: "failed", detail: `${hostname} resolves to ${seen}, not the server's ${expected.ip}.`, next: `Point it at the server: ${want}.` };
}

// ---- the proxy ----

function routeOf(hostname: string, view: ProxyView): ProxyRoute | undefined {
  return view.routes.find((r) => r.domains.some((d) => cleanHostname(d) === hostname));
}

export function evaluateProxy(hostname: string, proxy: ProxyFacts): Check {
  if (proxy.state === "error") return { state: "failed", detail: `The agent could not be asked about its proxy: ${proxy.message}`, next: "Check that the agent is online." };
  if (proxy.state === "none") {
    return { state: "failed", detail: "This agent has no reverse proxy, so no domain is served.", next: "Add a proxy section to the agent's apps file." };
  }
  const view = proxy.view;
  const route = routeOf(hostname, view);
  const kind = view.type === "caddy" ? "Caddy" : "nginx";
  if (!route) {
    const waiting = view.unrouted.find((u) => u.domains.some((d) => cleanHostname(d) === hostname));
    if (waiting) {
      return { state: "pending", detail: `${waiting.app} declares ${hostname} but has no route yet: ${waiting.reason}.`, next: "The route appears when the app's first deployment succeeds." };
    }
    return { state: "failed", detail: `${hostname} is not declared by any app or site of this agent.`, next: "Add it to the app's domains in the agent's configuration." };
  }
  const what = route.kind === "site" ? `the ${route.site_kind ?? "proxy"} site` : `app ${route.app}`;
  if (route.kind === "app" && !route.running) {
    return { state: "failed", detail: `${kind} routes ${hostname} to ${what}, but its container is not running.`, next: "Look at the app's page and its logs, or deploy it again." };
  }
  if (view.in_sync === false) {
    return { state: "failed", detail: `${kind} does not serve what the agent generates${view.live_error ? ` (${view.live_error})` : ""}.`, next: "The agent loads its routes again at the next deployment; check the Proxy tab." };
  }
  if (view.in_sync === undefined && view.live_error) {
    return { state: "failed", detail: `${kind} could not be read: ${view.live_error}.`, next: "Check that the proxy is running and its admin API is reachable by the agent." };
  }
  return { state: "ok", detail: `${kind} routes ${hostname} to ${what}.` };
}

// ---- HTTPS ----

const DAY = 86_400_000;

/** A certificate with this many days or fewer left is a warning: the proxy renews from 30 days out, so it is already late. */
export const CERT_WARN_DAYS = 14;
/** With this many days or fewer left, or none, it is a failure. */
export const CERT_FAIL_DAYS = 3;

const RENEW_HINT = "The proxy renews certificates by itself: check that ports 80 and 443 are reachable from the internet and that DNS points at this server, then look in the proxy's log for ACME errors.";

/** Caddy's own certificate authority (`tls: internal`): the certificates are real, but no browser trusts them. */
function isCaddyLocal(issuer: string): boolean {
  return /caddy local authority/i.test(issuer);
}

/** "60 days", "11 hours" or "30 minutes": Caddy's own certificates last twelve hours, so a count of days would say 0. */
export function span(ms: number): string {
  const d = Math.floor(ms / DAY);
  if (d >= 2) return `${d} days`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 2) return `${h} hours`;
  const m = Math.max(1, Math.floor(ms / 60_000));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export function evaluateHttps(f: { hostname: string; expected: ExpectedAddress | null; declared: boolean; cert: CertProbe | null; get: GetProbe | null; dnsOk: boolean; proxied: boolean; now: number }): Check {
  const { hostname, expected, cert, get } = f;
  if (!f.declared) return { state: "skipped", detail: "Not checked: only hosts the agent declares are probed." };
  if (expected === null) {
    return { state: "skipped", detail: "Not checked: the server's public address is not known.", next: "Set the public address in the server's settings." };
  }
  if (cert === null) return { state: "skipped", detail: "Not checked." };
  const at = `${expected.ip}:443`;
  switch (cert.kind) {
    case "refused":
      return { state: "failed", detail: `Nothing accepts connections on port 443 of ${expected.ip}.`, next: "Start the proxy (Caddy) and allow ports 80 and 443 in the server's firewall." };
    case "timeout":
      return { state: "failed", detail: `${at} did not answer within 5 seconds.`, next: "A firewall is probably dropping port 443: allow ports 80 and 443 from the internet." };
    case "unreachable":
      return { state: "failed", detail: `${at} could not be reached (${cert.message}).`, next: "Check the server's address in its settings and that the server is up." };
    case "no_cert":
      return {
        state: "pending",
        detail: `The proxy answers on 443 but has no certificate for ${hostname} yet.`,
        next: "Caddy obtains one by itself (ACME, HTTP-01 on port 80) once the name leads to this server and the app is deployed. Check again in a minute.",
      };
    default:
      break;
  }

  const left = cert.validTo - f.now;
  if (left <= 0) {
    return { state: "failed", detail: `The certificate (${cert.issuer}) expired ${span(-left)} ago.`, next: RENEW_HINT };
  }
  if (cert.validFrom > f.now) return { state: "failed", detail: `The certificate (${cert.issuer}) is not valid yet.`, next: "Check the server's clock." };
  if (!cert.matches) {
    return { state: "failed", detail: `The server presents a certificate for ${cert.names.join(", ") || "another name"}, not ${hostname}.`, next: "The proxy has no certificate for this name: see the proxy check above." };
  }
  if (!cert.trusted) {
    const local = isCaddyLocal(cert.issuer);
    const cloudflare = f.proxied ? " Visitors who go through Cloudflare are not affected unless its SSL mode is Full (strict)." : "";
    return {
      state: "failed",
      detail: `Certificate issued by ${cert.issuer}, not publicly trusted${local ? " (Caddy's internal authority, tls: internal)" : cert.trustError ? ` (${cert.trustError})` : ""}: browsers will warn.${cloudflare}`,
      next: local
        ? "Remove tls: internal from the agent's proxy configuration so that Caddy gets a Let's Encrypt certificate, or trust Caddy's root certificate on the machines that visit."
        : "Check the certificate chain the proxy serves.",
    };
  }

  if (left <= CERT_FAIL_DAYS * DAY) {
    return { state: "failed", detail: `The certificate (${cert.issuer}) has only ${span(left)} left and was not renewed.`, next: RENEW_HINT };
  }
  const expiring = left <= CERT_WARN_DAYS * DAY;
  const expires = `${span(left)} left`;
  if (get === null || get.kind === "error") {
    const why = get === null ? "was not requested" : get.message;
    if (!f.dnsOk) {
      return {
        state: "pending",
        detail: `The certificate (${cert.issuer}, ${expires}) is fine at the server's address, but https://${hostname}/ does not answer yet (${why}).`,
        next: "Waiting for DNS: see the check above.",
      };
    }
    return {
      state: "failed",
      detail: `The certificate (${cert.issuer}, ${expires}) is fine, but https://${hostname}/ could not be fetched: ${why}.`,
      next: "Try from another network. A firewall, Cloudflare's SSL mode or a stale DNS answer may be in the way.",
    };
  }
  const answered = `GET https://${hostname}/ answered ${get.status}${get.location ? ` (redirect to ${get.location})` : ""}`;
  if (get.status >= 500) {
    return { state: "failed", detail: `The certificate (${cert.issuer}, ${expires}) is fine, but ${answered}.`, next: "The proxy gets no good answer from the app: look at the app's container and its logs." };
  }
  if (expiring) return { state: "ok", warn: true, detail: `Valid certificate from ${cert.issuer}, but only ${expires}. ${answered}.`, next: RENEW_HINT };
  return { state: "ok", detail: `Valid certificate from ${cert.issuer}, ${expires}. ${answered}.` };
}

// ---- everything together ----

const SKIPPED_UNDECLARED: Check = { state: "skipped", detail: "Not checked: only hosts the agent declares are probed." };

/** The three checks for one host name from the facts gathered about it. */
export function assembleStatus(f: StatusFacts): DomainStatus {
  const cloudflare: DomainStatus["cloudflare"] = f.cloudflare.state === "ok" ? "connected" : f.cloudflare.state;
  const base = {
    hostname: f.hostname,
    checkedAt: f.now,
    expected: f.expected,
    cloudflare,
    ...(f.cloudflare.state === "error" ? { cloudflareError: f.cloudflare.message } : {}),
  };
  const proxy = evaluateProxy(f.hostname, f.proxy);
  if (!f.declared) return { ...base, dns: SKIPPED_UNDECLARED, proxy, https: SKIPPED_UNDECLARED };
  const dns = evaluateDns(f.hostname, f.expected, f.resolved, f.cloudflare);
  const record = rightRecord(f.hostname, f.expected, f.cloudflare);
  const https = evaluateHttps({
    hostname: f.hostname,
    expected: f.expected,
    declared: f.declared,
    cert: f.cert,
    get: f.get,
    dnsOk: dns.state === "ok",
    proxied: record?.proxied === true,
    now: f.now,
  });
  return { ...base, dns, proxy, https };
}

export function checks(status: DomainStatus): Check[] {
  return [status.dns, status.proxy, status.https];
}

/** The state of the whole domain: failed if a check failed, else pending if one is, else ok (skipped checks do not count). */
export function overall(status: DomainStatus): CheckState {
  const all = checks(status);
  if (all.some((c) => c.state === "failed")) return "failed";
  if (all.some((c) => c.state === "pending")) return "pending";
  return all.some((c) => c.state === "ok") ? "ok" : "skipped";
}

/** How long a page keeps re-checking a domain that is not done: the first minute often, then less, then it stops. */
export const POLL_LIMIT_MS = 10 * 60_000;

/** The wait before the next automatic check, or null to stop: nothing is pending, or ten minutes passed since polling began. */
export function pollDelay(elapsedMs: number, status: DomainStatus | null): number | null {
  if (status === null || !checks(status).some((c) => c.state === "pending")) return null;
  if (elapsedMs >= POLL_LIMIT_MS) return null;
  if (elapsedMs < 60_000) return 5_000;
  if (elapsedMs < 5 * 60_000) return 10_000;
  return 20_000;
}
