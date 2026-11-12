const TOKEN_SHAPE = /kst_[A-Za-z0-9_-]{16,}/g;
const BEARER = /\bBearer\s+[^\s"',;]+/gi;

/**
 * Removes the configured token, anything shaped like a Keelson token, and any bearer credential from a string.
 * Every string that leaves this process (tool output, errors, stderr) goes through it.
 */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(BEARER, "Bearer [redacted]").replace(TOKEN_SHAPE, "[redacted]");
}
