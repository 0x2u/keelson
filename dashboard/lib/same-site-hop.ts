/**
 * The session cookie is SameSite=Strict: a navigation that arrives from another site (GitHub redirecting the operator
 * back) carries no cookie, although the operator is signed in. Answering it with a page of this dashboard that
 * continues to the same address turns it into a same-site navigation, which does carry the cookie. A request that
 * already went through the hop (`hop=1`) and still has no session is really signed out.
 */

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The same path and query, with the marker that says the hop was made. */
export function hopTarget(url: URL): string {
  const next = new URL(url.pathname + url.search, "http://hop.invalid");
  next.searchParams.set("hop", "1");
  return `${next.pathname}${next.search}`;
}

export function hopped(url: URL): boolean {
  return url.searchParams.get("hop") === "1";
}

export const HOP_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

/** The page that continues, at once, to `target` (a path and query of this dashboard). */
export function hopHtml(target: string): string {
  const href = escapeHtml(target);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><meta name="referrer" content="no-referrer"><title>Continuing</title></head><body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:38rem;padding:0 1rem"><p>Continuing to Keelson… <a href="${href}">Continue</a></p></body></html>`;
}
