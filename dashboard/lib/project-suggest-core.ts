/**
 * What "New project" proposes after reading a repository: a framework card, a command to run before each deploy, a
 * database, and the names of the variables its example environment file lists. Pure: it reads the text of a few files
 * and returns suggestions with the reason for each. Nothing is applied by this module, and the operator can change every
 * one of them: a wrong guess costs one click, a missing one costs a form field.
 */

import type { PresetId } from "@/lib/presets-core";

/** What was read from the repository. A file that is missing or unreadable is null. */
export interface RepoFiles {
  /** Names of the files and directories at the root of the repository. */
  root: string[];
  /** At least one Dockerfile was found where the Dockerfile card looks. */
  hasDockerfile: boolean;
  packageJson: string | null;
  prismaSchema: string | null;
  /** `prisma/migrations` exists: migrations are applied by `migrate deploy`, not by `db push`. */
  prismaMigrations: boolean;
  /** `.env.example`, `.env.sample` or `.env.template`. */
  envExample: string | null;
}

export interface ProjectSuggestion {
  /** The card to preselect, and why. Null when nothing in the repository says. */
  framework: { id: PresetId; reason: string } | null;
  /** A release step, and why. */
  release: { command: string; reason: string } | null;
  /** The app talks to PostgreSQL, so a database is proposed. */
  database: { reason: string } | null;
  /** The variables the example environment file lists, by name only, in file order. */
  envNames: string[];
}

export const NO_SUGGESTION: ProjectSuggestion = { framework: null, release: null, database: null, envNames: [] };

/** Packages that mean "a Node.js server that listens on a port". */
const SERVER_PACKAGES = ["express", "fastify", "koa", "hono", "@nestjs/core", "@hapi/hapi", "restify", "@adonisjs/core"];
/** Packages that mean "talks to PostgreSQL". */
const POSTGRES_PACKAGES = ["pg", "postgres", "pg-promise", "@vercel/postgres", "@neondatabase/serverless", "slonik"];

const MAX_ENV_NAMES = 60;
const MIGRATE = "npx prisma migrate deploy";

interface PackageJson {
  deps: Set<string>;
  scripts: Set<string>;
}

function readPackageJson(text: string | null): PackageJson | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const keys = (v: unknown): string[] => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v) : []);
  return { deps: new Set([...keys(obj.dependencies), ...keys(obj.devDependencies)]), scripts: new Set(keys(obj.scripts)) };
}

function pickFramework(files: RepoFiles, pkg: PackageJson | null): ProjectSuggestion["framework"] {
  // A Dockerfile is the operator's own statement of how the app is built: it wins over a guess from package.json.
  if (files.hasDockerfile) return { id: "dockerfile", reason: "The repository has a Dockerfile." };
  if (pkg !== null) {
    if (pkg.deps.has("next")) return { id: "nextjs", reason: "package.json depends on next." };
    const server = SERVER_PACKAGES.find((p) => pkg.deps.has(p));
    if (pkg.deps.has("vite") && server === undefined && !pkg.scripts.has("start")) return { id: "vite", reason: "package.json depends on vite and has no server." };
    if (server !== undefined) return { id: "node", reason: `package.json depends on ${server}.` };
    if (pkg.scripts.has("start")) return { id: "node", reason: "package.json has a start script." };
    return null;
  }
  if (files.root.includes("index.html")) return { id: "static", reason: "index.html is at the root of the repository." };
  return null;
}

/** The names a `.env` example assigns, in order, each once. Comments, blank lines and values are ignored: only names are read. */
export function envNamesOf(text: string | null): string[] {
  if (text === null) return [];
  const seen = new Set<string>();
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) seen.add(m[1]!);
    if (seen.size >= MAX_ENV_NAMES) break;
  }
  return [...seen];
}

function pickDatabase(files: RepoFiles, pkg: PackageJson | null): ProjectSuggestion["database"] {
  if (files.prismaSchema !== null && /provider\s*=\s*"(?:postgresql|postgres)"/.test(files.prismaSchema)) return { reason: "prisma/schema.prisma uses PostgreSQL." };
  const driver = pkg === null ? undefined : POSTGRES_PACKAGES.find((p) => pkg.deps.has(p));
  if (driver !== undefined) return { reason: `package.json depends on ${driver}.` };
  if (files.envExample !== null && /^\s*DATABASE_URL\s*=\s*["']?postgres(?:ql)?:\/\//m.test(files.envExample)) return { reason: "The example environment file points DATABASE_URL at PostgreSQL." };
  return null;
}

/** The suggestions for a repository. The decisions are the operator's: every field is a proposal with its reason. */
export function suggestProject(files: RepoFiles): ProjectSuggestion {
  const pkg = readPackageJson(files.packageJson);
  const framework = pickFramework(files, pkg);
  const database = pickDatabase(files, pkg);
  // Migrations run in the new image: only the presets' images carry the project's own tooling (a Dockerfile's may not).
  const release =
    files.prismaSchema !== null && files.prismaMigrations && (framework?.id === "nextjs" || framework?.id === "node")
      ? { command: MIGRATE, reason: "prisma/migrations exists." }
      : null;
  // The database card fills DATABASE_URL: listing it again as a variable to add would invite the conflict it refuses.
  const envNames = envNamesOf(files.envExample).filter((n) => database === null || n !== "DATABASE_URL");
  return { framework, release, database, envNames };
}

/** A Dockerfile instruction that only BuildKit runs: the agent builds with the engine's classic builder. */
export function needsBuildkit(dockerfile: string): boolean {
  return /^\s*(?:RUN|COPY|ADD)\s+(?:--[a-z-]+(?:=\S*)?\s+)*--(?:mount|network|security|link)\b/im.test(dockerfile.replace(/\\\r?\n/g, " "));
}
