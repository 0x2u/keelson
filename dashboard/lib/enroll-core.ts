// Pure parts of enrolment with a one-time code. No "server-only": the form reads the string to suggest a name.
//
// The enrolment string is printed by `keelson-agent enroll-code`: "kse1." + base64url(JSON {"u": url, "fp": sha256 hex of
// the agent's server certificate (DER), "c": the code}). The code is a credential for a few minutes: never log or store it.

export const ENROL_PREFIX = "kse1.";
/** Far above what the agent prints (about 170 characters); a bound for a pasted string. */
const MAX_LENGTH = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export interface Enrolment {
  /** The agent's origin, https only, without a trailing slash. */
  url: string;
  host: string;
  /** SHA-256 of the agent's server certificate, lowercase hex. */
  fingerprint: string;
  /** The one-time code. A secret. */
  code: string;
}

export class EnrolmentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrolmentFormatError";
  }
}

/** UTF-8 text of an unpadded base64url string. Not Buffer: this runs in the browser too (the form suggests a name), where there is none. */
function decodeBase64url(body: string): string {
  const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** Strict: anything beyond exactly `u`, `fp` and `c` (or a malformed one of them) is refused. */
export function parseEnrolment(raw: string): Enrolment {
  const s = raw.trim();
  if (!s.startsWith(ENROL_PREFIX)) throw new EnrolmentFormatError(`This is not an enrolment string: it starts with “${ENROL_PREFIX}”.`);
  const body = s.slice(ENROL_PREFIX.length);
  if (s.length > MAX_LENGTH || body === "" || !BASE64URL.test(body)) throw new EnrolmentFormatError("The enrolment string is damaged: copy it again, whole.");

  let data: unknown;
  try {
    data = JSON.parse(decodeBase64url(body));
  } catch {
    throw new EnrolmentFormatError("The enrolment string is damaged: copy it again, whole.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new EnrolmentFormatError("The enrolment string is damaged: copy it again, whole.");
  const keys = Object.keys(data).sort().join(",");
  if (keys !== "c,fp,u") throw new EnrolmentFormatError("The enrolment string has unexpected content.");
  const { u, fp, c } = data as Record<string, unknown>;
  if (typeof u !== "string" || typeof fp !== "string" || typeof c !== "string") throw new EnrolmentFormatError("The enrolment string has unexpected content.");

  const origin = agentOrigin(u);
  if (origin === null) throw new EnrolmentFormatError("The agent address must be an https URL with a host and no credentials, path, query or fragment.");
  if (!FINGERPRINT.test(fp)) throw new EnrolmentFormatError("The certificate fingerprint is not a SHA-256 in hexadecimal.");
  if (c === "" || c.length > 256 || !BASE64URL.test(c)) throw new EnrolmentFormatError("The enrolment code is missing or malformed.");
  return { url: origin.url, host: origin.host, fingerprint: fp, code: c };
}

/** The same address rules as the add-server form (https here: the code and the keys never cross a clear channel), and nothing but an origin. */
function agentOrigin(raw: string): { url: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname === "" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (raw.includes("?") || raw.includes("#") || raw.includes("@")) return null;
  return { url: u.origin, host: u.hostname.replace(/^\[|\]$/g, "") };
}

/** The command that prints the string, for the form to show. */
export const ENROL_COMMAND = "sudo keelson-agent enroll-code";

const SERVER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u;
export function validServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

const PEM = /-----BEGIN [A-Z ]+-----[\s\S]+-----END [A-Z ]+-----/;
export interface EnrolGrant {
  caCert: string;
  clientCert: string;
  clientKey: string;
  token: string;
  /** Empty when the agent has no deploy secret: the server stays read-only. */
  deploySecret: string;
}

/** Validates the agent's answer to /v1/enroll before any of it is used. */
export function parseGrant(body: unknown): EnrolGrant | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { ca_pem: ca, client_cert_pem: cert, client_key_pem: key, token, deploy_secret: deploy } = b;
  if (typeof ca !== "string" || !PEM.test(ca) || !ca.includes("BEGIN CERTIFICATE")) return null;
  if (typeof cert !== "string" || !cert.includes("BEGIN CERTIFICATE")) return null;
  if (typeof key !== "string" || !/BEGIN [A-Z ]*PRIVATE KEY/.test(key)) return null;
  if (typeof token !== "string" || token.length < 32) return null;
  const secret = deploy === undefined || deploy === null ? "" : deploy;
  if (typeof secret !== "string" || (secret !== "" && (secret.length < 32 || secret === token))) return null;
  return { caCert: ca, clientCert: cert, clientKey: key, token, deploySecret: secret };
}

/**
 * The `?enrol=` link parameter: a string that looks like an enrolment, or nothing. It only pre-fills the form; whatever is
 * here is untrusted input and is validated again, strictly, when the operator presses the button.
 */
export function enrolParam(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s.startsWith(ENROL_PREFIX) && s.length <= MAX_LENGTH && BASE64URL.test(s.slice(ENROL_PREFIX.length)) ? s : undefined;
}
