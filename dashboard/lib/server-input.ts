// Pure validation, shared by the add and edit forms. No "server-only": tests import it.

import { isHostname, normalizePublicIp } from "@/lib/address-core";

export const MIN_SECRET_LENGTH = 32;
export const SERVER_NAME_MAX = 60;

/** What the operator typed. Empty strings mean "not provided". */
export interface ServerFormValues {
  name: string;
  url: string;
  token: string;
  deploySecret: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  /** The address domains must point at; empty = derive it from the agent's URL. Absent where a form has no such field. */
  publicIp?: string;
}

export type FieldErrors = Partial<Record<keyof ServerFormValues, string>>;

/** Normalizes a base URL: http(s) only, no credentials, query or fragment, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
    return null;
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * Validates the form. With existing set, an empty secret keeps the stored one,
 * so it is not an error; on creation the token is mandatory.
 */
export function validateServer(values: ServerFormValues, existing: boolean): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > SERVER_NAME_MAX) errors.name = `Between 1 and ${SERVER_NAME_MAX} characters.`;

  if (normalizeUrl(values.url) === null) {
    errors.url = "An http(s) URL without credentials, query or fragment, such as https://agent.example.com.";
  }

  if (values.token === "" ? !existing : values.token.length < MIN_SECRET_LENGTH) {
    errors.token = `At least ${MIN_SECRET_LENGTH} characters: the agent's API token.`;
  }
  if (values.deploySecret !== "" && values.deploySecret.length < MIN_SECRET_LENGTH) {
    errors.deploySecret = `At least ${MIN_SECRET_LENGTH} characters, or leave empty to keep this server read-only.`;
  }
  if (values.deploySecret !== "" && values.deploySecret === values.token) {
    errors.deploySecret = "Must differ from the API token.";
  }

  if (values.publicIp !== undefined && normalizePublicIp(values.publicIp) === null) {
    errors.publicIp = "An IPv4 or IPv6 address, such as 203.0.113.7, or leave it empty.";
  }

  if (values.caCert !== "" && !values.caCert.includes("BEGIN CERTIFICATE")) {
    errors.caCert = "Paste a PEM certificate.";
  }
  if (values.clientCert !== "" && !values.clientCert.includes("BEGIN CERTIFICATE")) {
    errors.clientCert = "Paste a PEM certificate.";
  }
  if (values.clientKey !== "" && !/BEGIN [A-Z ]*PRIVATE KEY/.test(values.clientKey)) {
    errors.clientKey = "Paste a PEM private key.";
  }
  // On edit, one half may already be stored: only creation can check the pair.
  if (!existing && (values.clientCert === "") !== (values.clientKey === "")) {
    errors.clientKey = "Client certificate and key go together.";
  }
  return errors;
}

/**
 * The domain a server's new projects get a host name under (`<project>.<domain>`), as typed: in lower case, no trailing
 * dot. null for an empty text (no default domain); undefined when it is not a plain domain name (an address, a URL, a
 * wildcard, one label).
 */
export function normalizeAppsDomain(text: string): string | null | undefined {
  const domain = text.trim().toLowerCase().replace(/\.$/, "");
  if (domain === "") return null;
  return isHostname(domain) ? domain : undefined;
}
