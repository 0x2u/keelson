export const REQUEST_TIMEOUT_MS = 15_000;

export interface Config {
  /** Dashboard origin (and optional path prefix), no trailing slash. */
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

/** A configuration problem. Its message never contains the token. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TOKEN_FORMAT = /^kst_[A-Za-z0-9_-]{43}$/;

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawUrl = env.KEELSON_URL?.trim();
  if (!rawUrl) throw new ConfigError("KEELSON_URL is not set (the dashboard address, e.g. https://keelson.example.com).");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError("KEELSON_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("KEELSON_URL must start with https://.");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new ConfigError("KEELSON_URL must use https:// (plain http is only accepted for localhost).");
  }
  if (url.username || url.password) throw new ConfigError("KEELSON_URL must not contain credentials.");
  if (url.search || url.hash) throw new ConfigError("KEELSON_URL must not contain a query or a fragment.");

  const token = env.KEELSON_TOKEN?.trim();
  if (!token) throw new ConfigError("KEELSON_TOKEN is not set (create one on the dashboard's API tokens page).");
  if (!TOKEN_FORMAT.test(token)) {
    throw new ConfigError("KEELSON_TOKEN is not a Keelson API token (expected kst_ followed by 43 characters).");
  }

  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, token, timeoutMs: REQUEST_TIMEOUT_MS };
}
