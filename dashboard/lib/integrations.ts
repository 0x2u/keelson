import "server-only";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

export interface GithubConnection {
  token: string;
  /** The GitHub account the token belongs to. */
  account: string;
}

export interface AppRepo {
  repo: string;
  branch: string;
  /** The workflow whose success on the branch deploys the app; null when automatic deploys are off. */
  autoDeployWorkflow: string | null;
  /** The workflow whose success on a pull request creates its preview; null when previews are off. */
  previewsWorkflow: string | null;
  /** A push to the linked branch is built and deployed by the app's agent (GitHub App). */
  buildOnPush: boolean;
  /** A pull request of the same repository is built and deployed as a preview by the agent (GitHub App). */
  buildPreviews: boolean;
  /** The server that builds the app when that is not the one that runs it (an id); null = the app's own server. */
  buildOn: string | null;
}

export interface GithubAppSummary {
  appId: string;
  /** The App's URL name on GitHub (github.com/apps/<slug>), or null when it is not known. */
  slug: string | null;
  /** The App's display name and its owner on GitHub: known only for an App Keelson created itself. */
  name: string | null;
  owner: { login: string; type: string } | null;
  createdAt: number;
}

/** The webhook secret's provider name in `integrations`: token_enc holds the secret, account stays empty. */
const WEBHOOK_PROVIDER = "github-webhook";

/** The GitHub App's provider name: token_enc holds the private key (PEM), account the App ID and slug as JSON (neither is secret). */
const APP_PROVIDER = "github-app";

/** The Cloudflare API token's provider name: token_enc holds the token, account the token's id and expiry as JSON (neither is secret). */
const CLOUDFLARE_PROVIDER = "cloudflare";

const APP_COLUMNS = "repo, branch, auto_deploy_workflow, previews_workflow, build_on_push, build_previews, build_server";

/** The stored GitHub token, or null when none is connected. */
export function githubConnection(): GithubConnection | null {
  const row = db().prepare("SELECT token_enc, account FROM integrations WHERE provider = 'github'").get();
  if (!row || typeof row.token_enc !== "string" || typeof row.account !== "string") return null;
  return { token: decrypt(row.token_enc), account: row.account };
}

export function saveGithubConnection(token: string, account: string): void {
  db()
    .prepare(
      `INSERT INTO integrations (provider, token_enc, account, created_at) VALUES ('github', ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET token_enc = excluded.token_enc, account = excluded.account, created_at = excluded.created_at`,
    )
    .run(encrypt(token), account, Date.now());
}

export function removeGithubConnection(): void {
  db().prepare("DELETE FROM integrations WHERE provider = 'github'").run();
}

function toAppRepo(row: Record<string, unknown> | undefined): AppRepo | null {
  if (!row || typeof row.repo !== "string" || typeof row.branch !== "string") return null;
  return {
    repo: row.repo,
    branch: row.branch,
    autoDeployWorkflow: typeof row.auto_deploy_workflow === "string" ? row.auto_deploy_workflow : null,
    previewsWorkflow: typeof row.previews_workflow === "string" ? row.previews_workflow : null,
    buildOnPush: row.build_on_push === 1,
    buildPreviews: row.build_previews === 1,
    buildOn: typeof row.build_server === "string" ? row.build_server : null,
  };
}

type LinkedApp = AppRepo & { serverId: string; app: string };

function linksOf(rows: Record<string, unknown>[]): LinkedApp[] {
  const out: LinkedApp[] = [];
  for (const row of rows) {
    const link = toAppRepo(row);
    if (link && typeof row.server_id === "string" && typeof row.app === "string") out.push({ ...link, serverId: row.server_id, app: row.app });
  }
  return out;
}

export function getAppRepo(serverId: string, app: string): AppRepo | null {
  return toAppRepo(db().prepare(`SELECT ${APP_COLUMNS} FROM app_repos WHERE server_id = ? AND app = ?`).get(serverId, app));
}

/**
 * Links an app to a repository and branch. Automatic deploys and previews are kept only while the repository and
 * branch stay the same: pointing the app at another source must not keep deploying from whatever the old workflow
 * name matches there.
 */
export function setAppRepo(serverId: string, app: string, link: { repo: string; branch: string }): void {
  db()
    .prepare(
      `INSERT INTO app_repos (server_id, app, repo, branch) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id, app) DO UPDATE SET
         auto_deploy_workflow = CASE WHEN repo = excluded.repo AND branch = excluded.branch THEN auto_deploy_workflow ELSE NULL END,
         previews_workflow = CASE WHEN repo = excluded.repo AND branch = excluded.branch THEN previews_workflow ELSE NULL END,
         build_on_push = CASE WHEN repo = excluded.repo AND branch = excluded.branch THEN build_on_push ELSE 0 END,
         build_previews = CASE WHEN repo = excluded.repo AND branch = excluded.branch THEN build_previews ELSE 0 END,
         repo = excluded.repo, branch = excluded.branch`,
    )
    .run(serverId, app, link.repo, link.branch);
}

/** Turns automatic deploys on for the workflow, or off with null. False when the app has no link. */
export function setAutoDeployWorkflow(serverId: string, app: string, workflow: string | null): boolean {
  return Number(db().prepare("UPDATE app_repos SET auto_deploy_workflow = ? WHERE server_id = ? AND app = ?").run(workflow, serverId, app).changes) > 0;
}

/** Turns previews on for the workflow, or off with null. False when the app has no link. */
export function setPreviewsWorkflow(serverId: string, app: string, workflow: string | null): boolean {
  return Number(db().prepare("UPDATE app_repos SET previews_workflow = ? WHERE server_id = ? AND app = ?").run(workflow, serverId, app).changes) > 0;
}

/** Every app, on any server, that deploys automatically from this repository (any letter case): the rest is up to the caller's match. */
export function autoDeployLinks(repo: string): LinkedApp[] {
  const rows = db()
    .prepare(`SELECT server_id, app, ${APP_COLUMNS} FROM app_repos WHERE auto_deploy_workflow IS NOT NULL AND lower(repo) = lower(?)`)
    .all(repo);
  return linksOf(rows);
}

/**
 * Every app, on any server, that has previews on for this repository (any letter case), by workflow or by build: the
 * rest is up to the caller's match. A closed pull request removes the previews of all of them.
 */
export function previewLinks(repo: string): LinkedApp[] {
  const rows = db()
    .prepare(`SELECT server_id, app, ${APP_COLUMNS} FROM app_repos WHERE (previews_workflow IS NOT NULL OR build_previews = 1) AND lower(repo) = lower(?)`)
    .all(repo);
  return linksOf(rows);
}

/** Turns the GitHub App builds of a linked app on or off. False when the app has no link. */
export function setBuildModes(serverId: string, app: string, modes: { onPush: boolean; previews: boolean }): boolean {
  return Number(db().prepare("UPDATE app_repos SET build_on_push = ?, build_previews = ? WHERE server_id = ? AND app = ?").run(modes.onPush ? 1 : 0, modes.previews ? 1 : 0, serverId, app).changes) > 0;
}

/** Builds the app on another server (its id), or on its own server with null. False when the app has no link. */
export function setBuildOn(serverId: string, app: string, buildServerId: string | null): boolean {
  return Number(db().prepare("UPDATE app_repos SET build_server = ? WHERE server_id = ? AND app = ?").run(buildServerId, serverId, app).changes) > 0;
}

/** Every app, on any server, that builds from this repository's pushes or pull requests (any letter case): the rest is up to the caller's match. */
export function buildLinks(repo: string): LinkedApp[] {
  const rows = db()
    .prepare(`SELECT server_id, app, ${APP_COLUMNS} FROM app_repos WHERE (build_on_push = 1 OR build_previews = 1) AND lower(repo) = lower(?)`)
    .all(repo);
  return linksOf(rows);
}

/** What is stored about the GitHub App, never its private key; null when none is set. */
export function githubAppSummary(): GithubAppSummary | null {
  const row = db().prepare("SELECT account, created_at FROM integrations WHERE provider = ?").get(APP_PROVIDER);
  if (!row || typeof row.account !== "string" || typeof row.created_at !== "number") return null;
  try {
    const meta: unknown = JSON.parse(row.account);
    if (typeof meta !== "object" || meta === null || !("appId" in meta) || typeof meta.appId !== "string") return null;
    const m = meta as Record<string, unknown>;
    const owner = m.owner;
    const ownerOk = typeof owner === "object" && owner !== null && typeof (owner as Record<string, unknown>).login === "string" && typeof (owner as Record<string, unknown>).type === "string";
    return {
      appId: meta.appId,
      slug: typeof m.slug === "string" ? m.slug : null,
      name: typeof m.name === "string" ? m.name : null,
      owner: ownerOk ? { login: (owner as { login: string }).login, type: (owner as { type: string }).type } : null,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/** The App's ID and private key for signing, or null when none is set. Only the GitHub App client reads it: the UI never gets the key back. */
export function githubAppCredentials(): { appId: string; privateKey: string } | null {
  const summary = githubAppSummary();
  const row = db().prepare("SELECT token_enc FROM integrations WHERE provider = ?").get(APP_PROVIDER);
  if (!summary || !row || typeof row.token_enc !== "string") return null;
  return { appId: summary.appId, privateKey: decrypt(row.token_enc) };
}

export function saveGithubApp(app: { appId: string; slug: string | null; privateKey: string; name?: string | null; owner?: { login: string; type: string } | null }): void {
  db()
    .prepare(
      `INSERT INTO integrations (provider, token_enc, account, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET token_enc = excluded.token_enc, account = excluded.account, created_at = excluded.created_at`,
    )
    .run(APP_PROVIDER, encrypt(app.privateKey), JSON.stringify({ appId: app.appId, slug: app.slug, name: app.name ?? null, owner: app.owner ?? null }), Date.now());
}

/** Removes the App's credentials and turns every build off: without the App nothing can be built. */
export function removeGithubApp(): void {
  db().prepare("DELETE FROM integrations WHERE provider = ?").run(APP_PROVIDER);
  db().prepare("UPDATE app_repos SET build_on_push = 0, build_previews = 0").run();
}

/** The webhook secret, or null when none is set. Only the verifier reads it: the UI never gets it back. */
export function webhookSecret(): string | null {
  const row = db().prepare("SELECT token_enc FROM integrations WHERE provider = ?").get(WEBHOOK_PROVIDER);
  return row && typeof row.token_enc === "string" ? decrypt(row.token_enc) : null;
}

/** When the webhook secret was generated (ms), or null when none is set. */
export function webhookSecretSince(): number | null {
  const row = db().prepare("SELECT created_at FROM integrations WHERE provider = ?").get(WEBHOOK_PROVIDER);
  return row && typeof row.created_at === "number" ? row.created_at : null;
}

/** Stores a fresh random secret (replacing any) and returns it: the only time it can be read by a person. */
export function regenerateWebhookSecret(): string {
  const secret = randomBytes(32).toString("hex");
  saveWebhookSecret(secret);
  return secret;
}

/** Stores a webhook secret chosen elsewhere (the one GitHub generated for an App it created for us), replacing any. */
export function saveWebhookSecret(secret: string): void {
  db()
    .prepare(
      `INSERT INTO integrations (provider, token_enc, account, created_at) VALUES (?, ?, '', ?)
       ON CONFLICT(provider) DO UPDATE SET token_enc = excluded.token_enc, account = '', created_at = excluded.created_at`,
    )
    .run(WEBHOOK_PROVIDER, encrypt(secret), Date.now());
}

export function removeWebhookSecret(): void {
  db().prepare("DELETE FROM integrations WHERE provider = ?").run(WEBHOOK_PROVIDER);
}

export interface CloudflareSummary {
  /** The token's id at Cloudflare (not its value); null when Cloudflare has no verify endpoint for this kind of token. */
  tokenId: string | null;
  expiresOn: string | null;
  connectedAt: number;
}

/** What is stored about the Cloudflare connection, never the token; null when none is connected. */
export function cloudflareSummary(): CloudflareSummary | null {
  const row = db().prepare("SELECT account, created_at FROM integrations WHERE provider = ?").get(CLOUDFLARE_PROVIDER);
  if (!row || typeof row.account !== "string" || typeof row.created_at !== "number") return null;
  try {
    const meta = JSON.parse(row.account) as Record<string, unknown>;
    return { tokenId: typeof meta.tokenId === "string" ? meta.tokenId : null, expiresOn: typeof meta.expiresOn === "string" ? meta.expiresOn : null, connectedAt: row.created_at };
  } catch {
    return null;
  }
}

/** The Cloudflare API token, or null when none is connected. Only lib/cloudflare's callers read it: the UI never gets it back. */
export function cloudflareToken(): string | null {
  const row = db().prepare("SELECT token_enc FROM integrations WHERE provider = ?").get(CLOUDFLARE_PROVIDER);
  return row && typeof row.token_enc === "string" ? decrypt(row.token_enc) : null;
}

export function saveCloudflare(token: string, meta: { tokenId: string | null; expiresOn: string | null }): void {
  db()
    .prepare(
      `INSERT INTO integrations (provider, token_enc, account, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET token_enc = excluded.token_enc, account = excluded.account, created_at = excluded.created_at`,
    )
    .run(CLOUDFLARE_PROVIDER, encrypt(token), JSON.stringify(meta), Date.now());
}

export function removeCloudflare(): void {
  db().prepare("DELETE FROM integrations WHERE provider = ?").run(CLOUDFLARE_PROVIDER);
}

export function removeAppRepo(serverId: string, app: string): void {
  db().prepare("DELETE FROM app_repos WHERE server_id = ? AND app = ?").run(serverId, app);
}
