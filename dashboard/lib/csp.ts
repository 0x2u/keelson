/**
 * The Content-Security-Policy for one response. Scripts run only with this response's nonce (and
 * what those scripts load, 'strict-dynamic'), so an injected <script> or inline handler does nothing.
 * Styles allow 'unsafe-inline' because the component library positions popovers with style attributes.
 * Forms post only to this dashboard, plus the `formTargets` of the one page that needs more (Connect GitHub posts the
 * App manifest to github.com).
 */
export function contentSecurityPolicy(nonce: string, dev = false, formTargets: string[] = []): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", ...formTargets],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** A fresh nonce: 128 random bits, base64. */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
