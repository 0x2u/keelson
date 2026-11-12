import { NextResponse, type NextRequest } from "next/server";
import { clientIpConfig, clientIpFrom, clientIpKnowable } from "@/lib/client-ip";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";
import { allowedIpsSpec, secureCookies, setupRequired } from "@/lib/env";
import { parseAllowlist, type Allowlist } from "@/lib/ip-allow";
import { HOP_HEADERS, hopHtml, hopTarget, hopped } from "@/lib/same-site-hop";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/session-token";

// Parsed once per process: a malformed KEELSON_ALLOWED_IPS fails loudly on the first request.
let allowlist: Allowlist | null | undefined;
function configuredAllowlist(): Allowlist | null {
  if (allowlist === undefined) {
    const spec = allowedIpsSpec();
    allowlist = spec ? parseAllowlist(spec) : null;
  }
  return allowlist;
}

/** Exactly the relay's routes: a machine has no session, and each of them checks the code or credential it is given. */
const RELAY_ROUTES = /^\/api\/relay\/(enrol|connect|binary|response\/[0-9a-f]{1,64}|request\/[0-9a-f]{1,64}\/body)$/;

/**
 * Reachable without a session: the sign-in pages, the first-run setup page (it answers only while no password exists: its
 * page and its action check that again, and the action needs the one-time token), the steps of a passkey sign-in, GitHub's
 * webhook (it carries its own HMAC signature), the REST API (every route under /api/v1 checks its own bearer token), the
 * routes machines that connect out to the dashboard use (each checks an enrolment code or the machine's credential), the
 * install script a server fetches before it has any credential (it holds no secret: the code is an argument the operator
 * types) and the return from GitHub's App creation. That last one is only let through here because the session cookie is
 * SameSite=Strict and does not accompany a navigation from github.com: its handler requires the session itself, after one
 * same-site hop.
 */
export function isPublic(pathname: string): boolean {
  return pathname === "/login" || pathname === "/login/verify" || pathname === "/setup" || pathname === "/install" || pathname === "/api/webhooks/github" || pathname === "/api/github/app/callback" || pathname.startsWith("/api/auth/passkey/login/") || isApiV1(pathname) || RELAY_ROUTES.test(pathname);
}

/** The page GitHub returns to after the App is installed (the manifest's setup URL). */
function isInstallReturn(url: URL): boolean {
  return url.pathname === "/settings/integrations" && url.searchParams.get("github") === "installed";
}

/** A path inside /api/v1, with no dot segment that could lead out of it. */
function isApiV1(pathname: string): boolean {
  return pathname.startsWith("/api/v1/") && !/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathname) && !pathname.includes("\\");
}

/**
 * The first gate: the IP allowlist, the security headers of every response, and a redirect to the login
 * page (401 for API calls) when there is no signed session. This is a convenience, not the only barrier:
 * pages, actions and route handlers verify the session again, including that it was not revoked.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const allowed = configuredAllowlist();
  if (allowed) {
    const config = clientIpConfig();
    if (!clientIpKnowable(config)) {
      return new NextResponse("KEELSON_ALLOWED_IPS needs KEELSON_TRUST_PROXY=true (or KEELSON_CLIENT_IP_HEADER): the client address comes from the reverse proxy.", { status: 500 });
    }
    if (!allowed.allows(clientIpFrom(request.headers, config))) return new NextResponse("Forbidden", { status: 403 });
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development", pathname === "/settings/integrations" ? ["https://github.com"] : []);
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set("x-pathname", pathname);
  forwarded.set("content-security-policy", csp);

  // Setup mode (no admin password exists yet): no session can exist, and the only page that answers is the setup page.
  // The state is read from the database only until a password exists; after that it is a flag in memory.
  const setupMode = setupRequired();
  const loggedIn = !setupMode && (await isValidSessionToken(request.cookies.get(SESSION_COOKIE)?.value));
  let response: NextResponse;
  if (setupMode) {
    if (pathname === "/setup") {
      response = NextResponse.next({ request: { headers: forwarded } });
    } else if (pathname.startsWith("/api/") || pathname === "/install") {
      // Machines and scripts must not be redirected to an HTML page (`curl | sh` would run it).
      response = new NextResponse("Keelson is not set up yet: open /setup in a browser to finish the installation.", { status: 503 });
    } else {
      response = NextResponse.redirect(new URL("/setup", request.url));
    }
  } else if (loggedIn || isPublic(pathname)) {
    // The login pages are never redirected from here: the cookie may be signed yet revoked,
    // and only the page can tell (it checks the database), so a redirect here could loop.
    response = NextResponse.next({ request: { headers: forwarded } });
  } else if (isInstallReturn(request.nextUrl) && !hopped(request.nextUrl)) {
    // GitHub sends the operator back here after installing the App: a cross-site navigation, which carries no
    // SameSite=Strict cookie. One hop through this dashboard's own page brings the cookie back; a real sign-out
    // goes through the hop too and is then redirected to the sign-in as usual.
    response = new NextResponse(hopHtml(hopTarget(request.nextUrl)), { status: 200, headers: HOP_HEADERS });
  } else if (pathname.startsWith("/api/")) {
    response = NextResponse.json({ error: "unauthorized" }, { status: 401 });
  } else {
    response = NextResponse.redirect(new URL("/login", request.url));
  }

  response.headers.set("Content-Security-Policy", csp);
  // Only meaningful over https, and harmful to promise on plain http.
  if (secureCookies()) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  // Everything except static assets (the icons hold nothing and are shown on the sign-in page) and the public health endpoint.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|api/health).*)"],
};
