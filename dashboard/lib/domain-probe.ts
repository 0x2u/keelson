import "server-only";
import { lookup } from "node:dns/promises";
import https from "node:https";
import tls from "node:tls";
import type { CertProbe, GetProbe, ResolveFacts } from "@/lib/domain-status-core";

/** Every probe gives up after this long. */
export const PROBE_TIMEOUT_MS = 5000;

/** What a caller may change: only tests do (a local server on another port, a CA to trust). */
export interface ProbeOptions {
  port?: number;
  timeoutMs?: number;
  ca?: string;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })), ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every address the system resolver (getaddrinfo: /etc/hosts and the configured DNS) gives for a name. Throws when it gives none. */
export async function resolveAll(host: string): Promise<string[]> {
  const found = await withTimeout(lookup(host, { all: true }), PROBE_TIMEOUT_MS);
  return [...new Set(found.map((a) => a.address))];
}

/** What a visitor's resolver would say for a name: the addresses, none (the name does not exist or has no address), or an error. */
export async function resolveHost(hostname: string): Promise<ResolveFacts> {
  try {
    const addresses = await resolveAll(hostname);
    return addresses.length > 0 ? { ok: true, addresses } : { ok: false, reason: "none" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { ok: false, reason: "none" };
    return { ok: false, reason: "error", message: code === "ETIMEOUT" ? "the resolver did not answer within 5 seconds" : `the resolver failed: ${code ?? "unknown error"}` };
  }
}

function name(entry: tls.Certificate | undefined, key: "O" | "CN"): string {
  const v = entry?.[key];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** "Let's Encrypt R11": the organisation and the common name of the issuer, once each. */
function issuerName(issuer: tls.Certificate | undefined): string {
  const org = name(issuer, "O");
  const cn = name(issuer, "CN");
  if (org !== "" && cn !== "" && !cn.toLowerCase().includes(org.toLowerCase())) return `${org} ${cn}`;
  return cn !== "" ? cn : org !== "" ? org : "an unknown issuer";
}

function certNames(cert: tls.PeerCertificate): string[] {
  const alt = (cert.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
  if (alt.length > 0) return alt;
  const cn = cert.subject?.CN;
  return typeof cn === "string" ? [cn] : [];
}

function classify(err: NodeJS.ErrnoException): CertProbe {
  const code = err.code ?? "";
  if (code === "ECONNREFUSED") return { kind: "refused" };
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return { kind: "timeout" };
  // The proxy answered the handshake with an alert: Caddy says "internal error" for a name it has no certificate for.
  if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS")) return { kind: "no_cert", message: err.message };
  return { kind: "unreachable", message: code !== "" ? code : err.message };
}

/**
 * Opens a TLS connection to `ip` port 443 with `hostname` as SNI and reads the certificate the server presents, whatever
 * DNS or Cloudflare say. The caller guarantees `ip` is the server's own address and `hostname` one of its declared hosts
 * (probeTarget): this function connects wherever it is told. No data is sent; no redirect exists at this level.
 */
export function probeCertificate(ip: string, hostname: string, options: ProbeOptions = {}): Promise<CertProbe> {
  const { promise, resolve } = Promise.withResolvers<CertProbe>();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let settled = false;
  const socket = tls.connect({ host: ip, port: options.port ?? 443, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs, ...(options.ca ? { ca: options.ca } : {}) });
  const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
  function finish(result: CertProbe): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  }
  socket.once("secureConnect", () => {
    const cert = socket.getPeerCertificate();
    if (!cert || Object.keys(cert).length === 0) {
      finish({ kind: "no_cert", message: "the server presented no certificate" });
      return;
    }
    const matches = tls.checkServerIdentity(hostname, cert) === undefined;
    const authorized = socket.authorized;
    finish({
      kind: "cert",
      issuer: issuerName(cert.issuer),
      names: certNames(cert),
      validFrom: Date.parse(cert.valid_from),
      validTo: Date.parse(cert.valid_to),
      matches,
      trusted: authorized && matches,
      // For a name that matches, the verifier's reason is about the chain (self-signed, unknown issuer, expired).
      ...(!authorized && matches ? { trustError: String(socket.authorizationError) } : {}),
    });
  });
  socket.once("timeout", () => finish({ kind: "timeout" }));
  socket.once("error", (err) => finish(classify(err)));
  return promise;
}

function explainGet(err: NodeJS.ErrnoException): string {
  const code = err.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the name does not resolve from this dashboard";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "no answer within 5 seconds";
  if (code === "ECONNRESET") return "the connection was reset";
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME/.test(code)) return `the certificate was not accepted (${code})`;
  return code !== "" ? code : "the request failed";
}

/**
 * GET https://hostname/ the way a visitor does: the name goes through the system resolver and the certificate must verify.
 * A redirect is reported, not followed. Gives up after five seconds. The caller guarantees `hostname` is declared on the
 * server's agent.
 */
export function fetchHttps(hostname: string, options: ProbeOptions = {}): Promise<GetProbe> {
  const { promise, resolve } = Promise.withResolvers<GetProbe>();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let settled = false;
  const finish = (result: GetProbe): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    req.destroy();
    resolve(result);
  };
  const req = https.request(
    { host: hostname, port: options.port ?? 443, path: "/", method: "GET", servername: hostname, agent: false, ...(options.ca ? { ca: options.ca } : {}), headers: { "User-Agent": "keelson-dashboard (domain check)", Accept: "*/*" } },
    (res) => {
      const location = typeof res.headers.location === "string" ? res.headers.location.slice(0, 120) : undefined;
      finish({ kind: "status", status: res.statusCode ?? 0, ...(location ? { location } : {}) });
    },
  );
  const timer = setTimeout(() => finish({ kind: "error", message: "no answer within 5 seconds" }), timeoutMs);
  req.once("error", (err: NodeJS.ErrnoException) => finish({ kind: "error", message: explainGet(err) }));
  req.end();
  return promise;
}
