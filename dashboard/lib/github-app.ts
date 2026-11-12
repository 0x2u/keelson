import "server-only";
import { z } from "zod";
import { githubAppCredentials } from "@/lib/integrations";
import { parseRepo } from "@/lib/github-core";
import { INSTALLATION_PERMISSIONS, RUNS_PERMISSIONS, signAppJwt } from "@/lib/github-app-core";

const API = "https://api.github.com";
const TIMEOUT_MS = 8000;
/** An installation token lives an hour; it is reused for less, so it never expires in the middle of a use. */
export const TOKEN_REUSE_MS = 50 * 60 * 1000;
/** The most tokens kept at once. */
export const TOKEN_CACHE_MAX = 100;

/** Why the App could not act: the message says what to change, and never contains a token or the key. */
export class GithubAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubAppError";
  }
}

/** What the App client needs from outside: the HTTP client, the clock and the stored credentials. Replaced in tests. */
export interface AppDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  credentials(): { appId: string; privateKey: string } | null;
}

const defaultDeps: AppDeps = { fetch: (url, init) => fetch(url, init), now: Date.now, credentials: githubAppCredentials };

function headers(bearer: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "keelson-dashboard",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function call(deps: AppDeps, url: string, init: RequestInit, explain: (status: number) => string): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GithubAppError("Could not reach api.github.com. Check this server's internet access.", 0);
  }
  if (!res.ok) throw new GithubAppError(explain(res.status), res.status);
  try {
    return await res.json();
  } catch {
    throw new GithubAppError("GitHub's answer was not what was expected.", 0);
  }
}

const BAD_CREDENTIALS = "GitHub rejected the App's credentials: check the App ID and the private key in Integrations.";

const Installation = z.object({ id: z.number().int().positive() });
const AccessToken = z.object({ token: z.string().min(1) });
const AppInfo = z.object({ slug: z.string().min(1) });

/** Who the App is on GitHub, to check the credentials when they are saved. Throws GithubAppError. */
export async function githubAppSlug(appId: string, privateKey: string, deps: AppDeps = defaultDeps): Promise<string> {
  const jwt = signAppJwt(appId, privateKey, Math.floor(deps.now() / 1000));
  const parsed = AppInfo.safeParse(
    await call(deps, `${API}/app`, { headers: headers(jwt) }, (status) => (status === 401 ? BAD_CREDENTIALS : `GitHub answered with status ${status}.`)),
  );
  if (!parsed.success) throw new GithubAppError("GitHub's answer was not what was expected.", 0);
  return parsed.data.slug;
}

/**
 * Installation tokens for repositories, minted on demand and kept in memory only: never stored, never logged. One
 * token per repository (the App's installation may cover more), limited to the permissions the builds need.
 * Concurrent requests for the same repository share one mint.
 */
export class InstallationTokens {
  private readonly cache = new Map<string, { token: string; until: number }>();
  private readonly minting = new Map<string, Promise<string>>();

  constructor(private readonly deps: AppDeps = defaultDeps) {}

  /**
   * A token for the repository ("owner/name"); throws GithubAppError saying what is missing. With `withActions` the token
   * can also list the workflow runs, which needs the App to have been given Actions: read (an App made before that
   * permission was added has to be changed on GitHub first).
   */
  async forRepo(repo: string, withActions = false): Promise<string> {
    const name = parseRepo(repo);
    if (!name) throw new GithubAppError("That is not a GitHub repository name.", 0);
    const credentials = this.deps.credentials();
    if (!credentials) throw new GithubAppError("The GitHub App is not configured in this dashboard.", 0);
    const key = `${credentials.appId}/${name.toLowerCase()}${withActions ? "+actions" : ""}`;

    const now = this.deps.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.token;
    if (hit) this.cache.delete(key);

    const running = this.minting.get(key);
    if (running) return running;
    const mint = this.mint(credentials, name, withActions)
      .then((token) => {
        this.remember(key, token);
        return token;
      })
      .finally(() => this.minting.delete(key));
    this.minting.set(key, mint);
    return mint;
  }

  /** Forgets every token: the credentials changed or were removed. */
  clear(): void {
    this.cache.clear();
    this.minting.clear();
  }

  private remember(key: string, token: string): void {
    const now = this.deps.now();
    for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
    while (this.cache.size >= TOKEN_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { token, until: now + TOKEN_REUSE_MS });
  }

  private async mint(credentials: { appId: string; privateKey: string }, repo: string, withActions: boolean): Promise<string> {
    let jwt: string;
    try {
      jwt = signAppJwt(credentials.appId, credentials.privateKey, Math.floor(this.deps.now() / 1000));
    } catch (err) {
      throw new GithubAppError(err instanceof Error ? err.message : "The App's private key cannot be used.", 0);
    }
    const installation = Installation.safeParse(
      await call(this.deps, `${API}/repos/${repo}/installation`, { headers: headers(jwt) }, (status) => {
        if (status === 401) return BAD_CREDENTIALS;
        if (status === 404) return `The GitHub App is not installed on ${repo}: install it on that repository from the App's page on GitHub.`;
        return `GitHub answered with status ${status} while looking for the App's installation on ${repo}.`;
      }),
    );
    if (!installation.success) throw new GithubAppError("GitHub's answer was not what was expected.", 0);

    const name = repo.slice(repo.indexOf("/") + 1);
    return mintToken(this.deps, jwt, installation.data.id, `creating an installation token for ${repo}`, {
      repositories: [name],
      permissions: withActions ? RUNS_PERMISSIONS : INSTALLATION_PERMISSIONS,
      denied: withActions
        ? `The GitHub App cannot read the workflow runs of ${repo}. On GitHub, open the App's settings, set Permissions, Repository permissions, Actions to Read-only, then accept the new permission on the installation (Settings, Applications, Installed GitHub Apps).`
        : `The GitHub App's installation on ${repo} does not grant what Keelson needs (Contents: read, Commit statuses: read and write, Pull requests: read): accept the permissions in the installation's settings on GitHub.`,
    });
  }
}

/**
 * Mints an installation token with the minimal permissions, for one repository (`repositories`) or, without it, for
 * every repository of the installation. The token is returned to the caller and kept nowhere here.
 */
async function mintToken(
  deps: AppDeps,
  jwt: string,
  installationId: number,
  doing: string,
  options: { repositories?: string[]; permissions?: Record<string, string>; denied: string },
): Promise<string> {
  const body = { ...(options.repositories ? { repositories: options.repositories } : {}), permissions: options.permissions ?? INSTALLATION_PERMISSIONS };
  const token = AccessToken.safeParse(
    await call(deps, `${API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: headers(jwt, true), body: JSON.stringify(body) }, (status) => {
      if (status === 401) return BAD_CREDENTIALS;
      if (status === 403 || status === 422) return options.denied;
      return `GitHub answered with status ${status} while ${doing}.`;
    }),
  );
  if (!token.success) throw new GithubAppError("GitHub's answer was not what was expected.", 0);
  return token.data.token;
}

export const installationTokens = new InstallationTokens();

/** A short-lived token to read and write the repository as the App; throws GithubAppError. */
export function installationToken(repo: string, withActions = false): Promise<string> {
  return installationTokens.forRepo(repo, withActions);
}

// ---- The repositories the App can reach ----------------------------------------------------------------------------
export interface InstalledRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  installationId: number;
}

export interface InstallationOverview {
  /** How many installations the App has (on accounts and organizations), including ones that could not be read. */
  installations: number;
  repos: InstalledRepo[];
  /** The list stopped at the cap: there are more repositories than shown. */
  truncated: boolean;
  /** Installations that could not be read (suspended, or the permissions not accepted yet), in words. */
  warnings: string[];
}

/** The most repositories listed, across all installations. */
export const REPO_CAP = 500;
/** The most installations read. */
export const INSTALLATION_CAP = 200;
/** How long a listing is reused. */
export const REPOS_CACHE_MS = 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 10;

const InstallationEntry = z.object({ id: z.number().int().positive(), account: z.object({ login: z.string() }).nullish(), suspended_at: z.string().nullish() });
const RepoEntry = z.object({ full_name: z.string().min(1), default_branch: z.string().min(1).nullish(), private: z.boolean(), pushed_at: z.string().nullish() });

async function pages<T>(fetchPage: (page: number) => Promise<T[]>, limit: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
    const items = await fetchPage(page);
    out.push(...items);
    if (items.length < PAGE) break;
  }
  return out;
}

/** Reads the App's installations and their repositories from GitHub, with tokens that live only inside this call. */
async function readInstallations(deps: AppDeps): Promise<InstallationOverview> {
  const credentials = deps.credentials();
  if (!credentials) throw new GithubAppError("The GitHub App is not configured in this dashboard.", 0);
  let jwt: string;
  try {
    jwt = signAppJwt(credentials.appId, credentials.privateKey, Math.floor(deps.now() / 1000));
  } catch (err) {
    throw new GithubAppError(err instanceof Error ? err.message : "The App's private key cannot be used.", 0);
  }

  const unexpected = () => new GithubAppError("GitHub's answer was not what was expected.", 0);
  const listed = await pages(async (page) => {
    const raw = await call(deps, `${API}/app/installations?per_page=${PAGE}&page=${page}`, { headers: headers(jwt) }, (status) =>
      status === 401 ? BAD_CREDENTIALS : `GitHub answered with status ${status} while listing the App's installations.`,
    );
    const parsed = z.array(InstallationEntry).safeParse(raw);
    if (!parsed.success) throw unexpected();
    return parsed.data;
  }, INSTALLATION_CAP);
  const installations = listed.slice(0, INSTALLATION_CAP);

  const found: { repo: InstalledRepo; pushedAt: string }[] = [];
  const warnings: string[] = [];
  let truncated = listed.length > INSTALLATION_CAP;
  for (const installation of installations) {
    const who = installation.account?.login ?? `installation ${installation.id}`;
    if (installation.suspended_at) {
      warnings.push(`${who}: the installation is suspended on GitHub.`);
      continue;
    }
    if (found.length >= REPO_CAP) {
      truncated = true;
      break;
    }
    let token: string;
    try {
      token = await mintToken(deps, jwt, installation.id, `creating an installation token for ${who}`, {
        denied: `${who}: the installation does not grant what Keelson needs (Contents: read, Commit statuses: read and write, Pull requests: read): accept the permissions in the installation's settings on GitHub.`,
      });
    } catch (err) {
      if (err instanceof GithubAppError && (err.status === 403 || err.status === 404 || err.status === 422)) {
        warnings.push(err.message);
        continue;
      }
      throw err;
    }
    const repos = await pages(async (page) => {
      const raw = await call(deps, `${API}/installation/repositories?per_page=${PAGE}&page=${page}`, { headers: headers(token) }, (status) =>
        status === 401 ? BAD_CREDENTIALS : `GitHub answered with status ${status} while listing the repositories of ${who}.`,
      );
      const parsed = z.object({ repositories: z.array(RepoEntry) }).safeParse(raw);
      if (!parsed.success) throw unexpected();
      return parsed.data.repositories;
    }, REPO_CAP - found.length);
    for (const r of repos) {
      if (found.length >= REPO_CAP) {
        truncated = true;
        break;
      }
      found.push({ repo: { fullName: r.full_name, defaultBranch: r.default_branch ?? "main", private: r.private, installationId: installation.id }, pushedAt: r.pushed_at ?? "" });
    }
  }
  // Newest push first; repositories without a push time keep their order after the rest.
  const order = found.map((f, i) => ({ ...f, i })).sort((a, b) => (a.pushedAt === b.pushedAt ? a.i - b.i : a.pushedAt < b.pushedAt ? 1 : -1));
  return { installations: listed.length, repos: order.map((o) => o.repo), truncated, warnings };
}

/** The listing, kept for a minute in memory (never the tokens it was made with). Concurrent callers share one read. */
export class InstalledRepos {
  private hit: { appId: string; until: number; value: InstallationOverview } | null = null;
  private running: { appId: string; promise: Promise<InstallationOverview> } | null = null;

  constructor(private readonly deps: AppDeps = defaultDeps) {}

  async overview(): Promise<InstallationOverview> {
    const credentials = this.deps.credentials();
    if (!credentials) {
      this.clear();
      throw new GithubAppError("The GitHub App is not configured in this dashboard.", 0);
    }
    if (this.hit && this.hit.appId === credentials.appId && this.hit.until > this.deps.now()) return this.hit.value;
    if (this.running && this.running.appId === credentials.appId) return this.running.promise;
    const promise = readInstallations(this.deps)
      .then((value) => {
        this.hit = { appId: credentials.appId, until: this.deps.now() + REPOS_CACHE_MS, value };
        return value;
      })
      .finally(() => {
        if (this.running?.promise === promise) this.running = null;
      });
    this.running = { appId: credentials.appId, promise };
    return promise;
  }

  /** Forgets the listing: the credentials changed, or the operator asked for a fresh look. */
  clear(): void {
    this.hit = null;
    this.running = null;
  }
}

export const installedRepos = new InstalledRepos();

/** Repositories the configured GitHub App can reach, across all its installations (no PAT needed). Throws GithubAppError when no App is configured. Cached for a minute. */
export async function listInstalledRepos(): Promise<InstalledRepo[]> {
  return (await installedRepos.overview()).repos;
}

/** Like `listInstalledRepos`, with the number of installations and what could not be read: what the Integrations page shows. */
export function installationOverview(): Promise<InstallationOverview> {
  return installedRepos.overview();
}

/** Drops the cached listing (after the App is replaced or removed, or when the operator asks to refresh). */
export function invalidateInstalledRepos(): void {
  installedRepos.clear();
}
