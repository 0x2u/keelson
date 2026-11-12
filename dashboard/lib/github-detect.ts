import "server-only";
import { z } from "zod";
import { GithubAppError, installationToken } from "@/lib/github-app";
import { isBranchName, parseRepo } from "@/lib/github-core";
import { contextOf, dockerfileInContext, dockerfilePlaces, orderDockerfiles, parseDockerfile, type TreeEntry } from "@/lib/repo-detect-core";
import { needsBuildkit, suggestProject, type ProjectSuggestion } from "@/lib/project-suggest-core";

const API = "https://api.github.com";
const TIMEOUT_MS = 8000;
/** A Dockerfile larger than this is not read: it is not what a Dockerfile looks like. */
const MAX_DOCKERFILE_BYTES = 200 * 1024;
/** The Dockerfiles that are read for their port and health check. */
const MAX_CANDIDATES = 4;

/** Why the repository could not be read: the message says what to change, and never holds a token. */
export class RepoReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RepoReadError";
  }
}

/** What detection needs from outside: the HTTP client and the installation token. Replaced in tests. */
export interface DetectDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  token(repo: string): Promise<string>;
}

const defaultDeps: DetectDeps = { fetch: (url, init) => fetch(url, init), token: installationToken };

export interface DockerfileCandidate {
  /** The path in the repository. */
  path: string;
  /** The build context that usually goes with it. */
  context: string;
  /** The Dockerfile relative to that context: what the agent's `build.dockerfile` holds. */
  dockerfile: string;
  port: number | null;
  portFromVariable: boolean;
  healthcheck: boolean;
  /** The Dockerfile uses an instruction only BuildKit runs (`RUN --mount`, `COPY --link`): the agent's classic builder refuses it. */
  buildkit?: true;
}

export interface RepoDetection {
  repo: string;
  defaultBranch: string;
  /** The head of the default branch when it was read. */
  sha: string;
  private: boolean;
  candidates: DockerfileCandidate[];
  /** More directories than were searched, or more Dockerfiles than were read. */
  truncated: boolean;
  /** What the repository suggests: a framework, a release command, a database, the variables its example file lists. */
  suggestion: ProjectSuggestion;
}

async function get(deps: DetectDeps, token: string, path: string, query: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await deps.fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "keelson-dashboard" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RepoReadError("Could not reach api.github.com. Check this server's internet access.", 0);
  }
  if (!res.ok) {
    if (res.status === 404) throw new RepoReadError("GitHub has no such file, branch or repository, or the GitHub App cannot see it.", 404);
    // GitHub answers 409 "Git Repository is empty" for the commits of a repository that has none.
    if (res.status === 409) throw new RepoReadError("This repository is empty. Push a first commit with a Dockerfile, then add it.", 409);
    if (res.status === 403 || res.status === 429) throw new RepoReadError("GitHub refused the request: the App's installation may lack Contents: read, or its request limit is used up.", res.status);
    throw new RepoReadError(`GitHub answered with status ${res.status}.`, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new RepoReadError("GitHub's answer was not what was expected.", 0);
  }
}

const unexpected = () => new RepoReadError("GitHub's answer was not what was expected.", 0);

const RepoInfo = z.object({ default_branch: z.string().min(1), private: z.boolean().optional() });
const CommitInfo = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const Listing = z.array(z.object({ name: z.string(), type: z.string() }));
const FileInfo = z.object({ type: z.literal("file"), size: z.number().int().optional(), encoding: z.string().optional(), content: z.string().optional() });

const segments = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** The directory's entries, or null when there is no such directory. */
async function list(deps: DetectDeps, token: string, repo: string, dir: string, ref: string): Promise<TreeEntry[] | null> {
  try {
    const parsed = Listing.safeParse(await get(deps, token, `/repos/${repo}/contents/${dir === "" ? "" : segments(dir)}`, { ref }));
    if (!parsed.success) throw unexpected();
    return parsed.data.flatMap((e): TreeEntry[] => (e.type === "file" || e.type === "dir" ? [{ name: e.name, type: e.type }] : []));
  } catch (err) {
    if (err instanceof RepoReadError && err.status === 404 && dir !== "") return null;
    throw err;
  }
}

/** A file's text, or null when it is missing, too large or not text. */
async function fileText(deps: DetectDeps, token: string, repo: string, file: string, ref: string): Promise<string | null> {
  try {
    const parsed = FileInfo.safeParse(await get(deps, token, `/repos/${repo}/contents/${segments(file)}`, { ref }));
    if (!parsed.success || parsed.data.content === undefined || parsed.data.encoding !== "base64") return null;
    if ((parsed.data.size ?? 0) > MAX_DOCKERFILE_BYTES) return null;
    return Buffer.from(parsed.data.content, "base64").toString("utf8");
  } catch (err) {
    if (err instanceof RepoReadError && err.status === 404) return null;
    throw err;
  }
}

/** The head commit of a branch: its full SHA. */
export async function branchHead(repo: string, branch: string, deps: DetectDeps = defaultDeps): Promise<string> {
  const name = parseRepo(repo);
  if (!name) throw new RepoReadError("That is not a GitHub repository name.", 0);
  if (!isBranchName(branch)) throw new RepoReadError("That is not a valid branch name.", 0);
  const token = await mint(deps, name);
  const parsed = CommitInfo.safeParse(await get(deps, token, `/repos/${name}/commits/${encodeURIComponent(branch)}`));
  if (!parsed.success) throw unexpected();
  return parsed.data.sha;
}

async function mint(deps: DetectDeps, repo: string): Promise<string> {
  try {
    return await deps.token(repo);
  } catch (err) {
    if (err instanceof GithubAppError) throw new RepoReadError(err.message, err.status);
    throw new RepoReadError("Unexpected error creating the GitHub App's installation token.", 0);
  }
}

/**
 * Reads the repository, read-only and with an installation token for that repository alone: its default branch and head,
 * and the Dockerfiles in the likely places (the root, `docker/`, `deploy/`, and one level of subdirectories), each with
 * the port and health check it declares. Throws RepoReadError.
 */
export async function detectRepo(repo: string, deps: DetectDeps = defaultDeps): Promise<RepoDetection> {
  const name = parseRepo(repo);
  if (!name) throw new RepoReadError("That is not a GitHub repository name.", 0);
  const token = await mint(deps, name);
  const info = RepoInfo.safeParse(await get(deps, token, `/repos/${name}`));
  if (!info.success) throw unexpected();
  const branch = info.data.default_branch;
  if (!isBranchName(branch)) throw unexpected();
  const commit = CommitInfo.safeParse(await get(deps, token, `/repos/${name}/commits/${encodeURIComponent(branch)}`));
  if (!commit.success) throw unexpected();
  const sha = commit.data.sha;

  const root = (await list(deps, token, name, "", sha)) ?? [];
  const places = dockerfilePlaces(root);
  const found = [...places.files];
  const listings = await Promise.all(places.dirs.map(async (dir) => ({ dir, entries: await list(deps, token, name, dir, sha) })));
  for (const { dir, entries } of listings) {
    if (entries?.some((e) => e.type === "file" && e.name === "Dockerfile")) found.push(`${dir}/Dockerfile`);
  }
  const ordered = orderDockerfiles(found);

  const candidates: DockerfileCandidate[] = [];
  for (const file of ordered.slice(0, MAX_CANDIDATES)) {
    const text = await fileText(deps, token, name, file, sha);
    if (text === null) continue;
    const context = contextOf(file);
    const facts = parseDockerfile(text);
    candidates.push({ path: file, context, dockerfile: dockerfileInContext(file, context) ?? file, ...facts, ...(needsBuildkit(text) ? { buildkit: true as const } : {}) });
  }

  // Only files the root listing shows are asked for: a repository without them costs no request.
  const rootFiles = new Set(root.filter((e) => e.type === "file").map((e) => e.name));
  const readIf = (present: boolean, file: string) => (present ? fileText(deps, token, name, file, sha) : Promise.resolve(null));
  const prismaDir = root.some((e) => e.type === "dir" && e.name === "prisma") ? await list(deps, token, name, "prisma", sha) : null;
  const envName = [".env.example", ".env.sample", ".env.template"].find((n) => rootFiles.has(n));
  const [packageJson, prismaSchema, envExample] = await Promise.all([
    readIf(rootFiles.has("package.json"), "package.json"),
    readIf(prismaDir?.some((e) => e.type === "file" && e.name === "schema.prisma") === true, "prisma/schema.prisma"),
    readIf(envName !== undefined, envName ?? ""),
  ]);
  const suggestion = suggestProject({
    root: root.map((e) => e.name),
    hasDockerfile: candidates.length > 0,
    packageJson,
    prismaSchema,
    prismaMigrations: prismaDir?.some((e) => e.type === "dir" && e.name === "migrations") === true,
    envExample,
  });
  return {
    repo: name,
    defaultBranch: branch,
    sha,
    private: info.data.private === true,
    candidates,
    suggestion,
    truncated: places.truncated || ordered.length > MAX_CANDIDATES,
  };
}
