import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { audit } from "@/lib/auth/store";
import { db } from "@/lib/db";
import { HOP_HEADERS, hopHtml, hopTarget, hopped } from "@/lib/same-site-hop";
import { installationTokens, invalidateInstalledRepos } from "@/lib/github-app";
import { parsePrivateKey } from "@/lib/github-app-core";
import {
  Conversion,
  FAILURES,
  INTEGRATIONS_PATH,
  STATE_TTL_MS,
  installUrl,
  publicBase,
  type FailureCode,
  type PublicBase,
} from "@/lib/github-connect-core";
import { saveGithubApp, saveWebhookSecret } from "@/lib/integrations";
import { clientInfo, currentSession, hasSession } from "@/lib/session";

/** The address GitHub calls back (KEELSON_PUBLIC_URL), or why the flow is unavailable. */
export function connectBase(): PublicBase {
  return publicBase(process.env.KEELSON_PUBLIC_URL, process.env.KEELSON_INSECURE_COOKIES === "true");
}

// ---- The single-use state --------------------------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A new state for the session: 32 random bytes, returned once and stored only as its hash. A session has at most one
 * pending state (a new attempt replaces the previous one); expired states of any session are swept.
 */
export function createConnectState(sessionId: string, now: number = Date.now()): string {
  const state = randomBytes(32).toString("base64url");
  const conn = db();
  conn.prepare("DELETE FROM github_app_states WHERE expires_at <= ? OR session_id = ?").run(now, sessionId);
  conn.prepare("INSERT INTO github_app_states (hash, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(state), sessionId, now, now + STATE_TTL_MS);
  return state;
}

/** Consumes a state: whatever the outcome, the row is gone afterwards, so a state can be tried once. */
export function consumeConnectState(state: string, sessionId: string, now: number = Date.now()): "ok" | "bad_state" | "expired_state" | "other_session" {
  const row = db().prepare("DELETE FROM github_app_states WHERE hash = ? RETURNING session_id, expires_at").get(sha256(state));
  if (!row || typeof row.session_id !== "string" || typeof row.expires_at !== "number") return "bad_state";
  if (row.expires_at <= now) return "expired_state";
  if (row.session_id !== sessionId) return "other_session";
  return "ok";
}

// ---- GitHub's conversion ---------------------------------------------------------------------------------------------

export interface ConnectDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
}
const defaultDeps: ConnectDeps = { fetch: (url, init) => fetch(url, init) };

/** Exchanges the manifest code for the App's credentials. The result carries secrets: it is never logged or returned to a page. */
export async function convertManifest(code: string, deps: ConnectDeps = defaultDeps): Promise<Conversion> {
  let res: Response;
  try {
    res = await deps.fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "keelson-dashboard" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ConnectFailure("unreachable");
  }
  if (res.status === 404 || res.status === 422) throw new ConnectFailure("refused");
  if (!res.ok) throw new ConnectFailure("github_error");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConnectFailure("bad_answer");
  }
  const parsed = Conversion.safeParse(body);
  if (!parsed.success) throw new ConnectFailure("bad_answer");
  try {
    parsePrivateKey(parsed.data.pem);
  } catch {
    throw new ConnectFailure("bad_answer");
  }
  return parsed.data;
}

class ConnectFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(FAILURES[code]);
  }
}

// ---- The callback ----------------------------------------------------------------------------------------------------

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const CODE = /^[A-Za-z0-9_-]{8,128}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function htmlPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

/** Where a failure lands: the Integrations page, which shows the fixed sentence of the code. */
function failureLocation(origin: string, code: FailureCode): string {
  return `${origin}${INTEGRATIONS_PATH}?github_error=${code}`;
}

/**
 * GET /api/github/app/callback?code&state: where GitHub sends the operator after the App was created from the manifest.
 * It needs the operator's session: the state must be the single-use one this session started. The cookie is
 * SameSite=Strict, so a request that arrives from github.com carries none: such a request first gets a page of this
 * dashboard that continues to the same address (lib/same-site-hop.ts), and only then is the session required. No secret is ever in a response: the credentials go from GitHub's answer to the database.
 */
export async function handleGithubAppCallback(request: Request, deps: ConnectDeps = defaultDeps): Promise<Response> {
  const base = connectBase();
  if (!base.ok) return htmlPage(503, "GitHub cannot be connected", `<p>${escapeHtml(base.error)}</p>`);
  const origin = base.origin;
  const ip = (await clientInfo()).ip;
  const url = new URL(request.url);

  if (!(await hasSession())) {
    if (!hopped(url)) {
      // Only code and state are carried on: nothing else from the request is echoed into the page.
      const next = new URL(url.pathname, origin);
      for (const key of ["code", "state"]) {
        const value = url.searchParams.get(key);
        if (value !== null) next.searchParams.set(key, value);
      }
      return new Response(hopHtml(hopTarget(next)), { status: 200, headers: HOP_HEADERS });
    }
    audit("github_app_callback_refused", "no session", ip);
    return htmlPage(
      401,
      "Sign in to finish connecting GitHub",
      `<p>The connection must be finished from the session that started it. <a href="/login">Sign in</a>, then start again with Connect GitHub in Settings, Integrations.</p>`,
    );
  }

  const fail = (code: FailureCode, detail?: string): Response => {
    audit("github_app_connect_failed", detail ? `${code}: ${detail}` : code, ip);
    return redirect(failureLocation(origin, code));
  };

  const session = await currentSession();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!session) return fail("bad_state", "no session record");
  if (!CODE.test(code) || !STATE.test(state)) return fail("no_state");
  const checked = consumeConnectState(state, session.id);
  if (checked !== "ok") return fail(checked);

  let app: Conversion;
  try {
    app = await convertManifest(code, deps);
  } catch (err) {
    if (err instanceof ConnectFailure) return fail(err.code);
    return fail("github_error");
  }

  const replaced = Boolean(db().prepare("SELECT 1 AS x FROM integrations WHERE provider IN ('github-app', 'github-webhook')").get());
  saveGithubApp({ appId: String(app.id), slug: app.slug, privateKey: app.pem, name: app.name, owner: app.owner ?? null });
  saveWebhookSecret(app.webhook_secret);
  installationTokens.clear();
  invalidateInstalledRepos();
  audit("github_app_created", `App ${app.id} (${app.slug})${app.owner ? ` owned by ${app.owner.login}` : ""}${replaced ? ", replacing the previous App and webhook secret" : ""}`, ip);
  return redirect(installUrl(app.slug));
}
