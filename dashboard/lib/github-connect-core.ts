/**
 * Pure rules of "Connect GitHub" (GitHub's App manifest flow): the public address the flow needs, the manifest posted
 * to GitHub, the addresses involved and the shape of GitHub's answer. No database, no network.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RUNS_PERMISSIONS, isAppSlug } from "@/lib/github-app-core";
import { PUBLIC_URL_HOW } from "@/lib/public-url-help-core";

export const CALLBACK_PATH = "/api/github/app/callback";
export const WEBHOOK_PATH = "/api/webhooks/github";
/** Where GitHub sends the operator after the App is installed (and after an installation is changed). */
export const SETUP_PATH = "/settings/integrations?github=installed";
export const INTEGRATIONS_PATH = "/settings/integrations";

/** What a state lives: GitHub shows its own page in between, so ten minutes is generous. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** The events the App subscribes to: pushes and pull requests are what builds start from. */
export const APP_EVENTS = ["push", "pull_request"] as const;

const NAME_MAX = 34;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type PublicBase = { ok: true; origin: string } | { ok: false; error: string };

/**
 * The address GitHub will call back, from KEELSON_PUBLIC_URL: https, or plain http on a development machine
 * (KEELSON_INSECURE_COOKIES=true). Anything else disables the flow and says why.
 */
export function publicBase(raw: string | undefined, insecureDev: boolean): PublicBase {
  const missing = `GitHub can only call this dashboard back over https, and KEELSON_PUBLIC_URL (the https address it is served at) is not set. ${PUBLIC_URL_HOW}`;
  if (!raw) return { ok: false, error: missing };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "KEELSON_PUBLIC_URL is not a valid address. It must look like https://keelson.example.com." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && insecureDev && local)) return { ok: true, origin: url.origin };
  return { ok: false, error: `KEELSON_PUBLIC_URL must be an https address: GitHub only calls back over https. ${PUBLIC_URL_HOW}` };
}

/** A name that is probably free on GitHub: App names are unique across GitHub. */
export function defaultAppName(): string {
  return `Keelson ${randomBytes(3).toString("hex")}`;
}

/** The App's name as typed: trimmed, 1 to 34 characters (GitHub's limit), no control characters. */
export function validAppName(raw: string): string | null {
  const name = raw.trim();
  if (name === "" || name.length > NAME_MAX || /[\u0000-\u001f\u007f<>"]/.test(name)) return null;
  return name;
}

export function isOrgLogin(text: string): boolean {
  return ORG.test(text);
}

/** The manifest GitHub turns into an App. Everything but the name is derived from the public address. */
export function buildManifest(origin: string, name: string): Record<string, unknown> {
  return {
    name,
    url: origin,
    hook_attributes: { url: `${origin}${WEBHOOK_PATH}`, active: true },
    redirect_url: `${origin}${CALLBACK_PATH}`,
    setup_url: `${origin}${SETUP_PATH}`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...RUNS_PERMISSIONS },
    default_events: [...APP_EVENTS],
  };
}

/** The page the manifest is posted to, with the state: the operator's account, or an organization they own. */
export function manifestFormAction(org: string | null, state: string): string {
  const base = org === null ? "https://github.com/settings/apps/new" : `https://github.com/organizations/${org}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** Where the App is installed on an account or organization (GitHub returns to the setup URL afterwards). */
export function installUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

/** The App's settings page on GitHub: it depends on whether an organization or a person owns it. */
export function appSettingsUrl(slug: string, owner: { login: string; type: string } | null): string | null {
  if (!isAppSlug(slug)) return null;
  if (owner === null) return `https://github.com/apps/${slug}`;
  if (owner.type === "Organization" && isOrgLogin(owner.login)) return `https://github.com/organizations/${owner.login}/settings/apps/${slug}`;
  return `https://github.com/settings/apps/${slug}`;
}

/** The part of GitHub's conversion answer that is used: client_id and client_secret are deliberately not read. */
export const Conversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().refine(isAppSlug),
  name: z.string().min(1).max(200),
  pem: z.string().min(1).max(16 * 1024),
  webhook_secret: z.string().min(1).max(512),
  owner: z.object({ login: z.string().min(1).max(100), type: z.string().min(1).max(50) }).nullish(),
});
export type Conversion = z.infer<typeof Conversion>;

/** The reasons the callback can end in a failure; the page shows a fixed sentence per code, never text from the request. */
export const FAILURES = {
  no_state: "This link is not a GitHub connection started here: it has no code or no state. Start again with Connect GitHub.",
  bad_state: "This connection was not started by this dashboard, or it was already used. Start again with Connect GitHub.",
  expired_state: "The connection was started more than 10 minutes ago. Start again with Connect GitHub.",
  other_session: "The connection was started from another session. Start again with Connect GitHub from this one.",
  refused: "GitHub refused the code: it expired (a code lives one hour) or was already used. Start again with Connect GitHub.",
  github_error: "GitHub could not create the App just now. Try again in a few minutes.",
  unreachable: "This server could not reach api.github.com. Check its internet access, then start again.",
  bad_answer: "GitHub's answer was not what was expected, so nothing was saved. Start again, or use Advanced / manual setup.",
  no_public_url: `GitHub can only call this dashboard back over https, and KEELSON_PUBLIC_URL (the https address it is served at) is not set. ${PUBLIC_URL_HOW}`,
} as const;
export type FailureCode = keyof typeof FAILURES;

export function isFailureCode(code: string | undefined): code is FailureCode {
  return code !== undefined && Object.hasOwn(FAILURES, code);
}
