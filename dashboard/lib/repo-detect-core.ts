/**
 * Pure rules of "Add an app from a repository": reading a Dockerfile, choosing where it lives, suggesting a name and a
 * port, checking the review form and building the app the agent is asked to store. No database, no network.
 */

import path from "node:path";
import { isBranchName } from "@/lib/github-core";
import type { AppConfig, ConfigModel } from "@/lib/agent-types";
import { portParts } from "@/lib/app-config-core";
import { commandProblem, getPreset, isPresetId, toBuildBlock, validatePresetHealthPath, validatePresetOptions, validatePresetPort, type PresetField, type PresetId, type PresetOptions } from "@/lib/presets-core";

// ---- the Dockerfile ----

export interface DockerfileFacts {
  /** The first TCP port of the last EXPOSE of the final stage; null when there is none or it is not written as a number. */
  port: number | null;
  /** The last EXPOSE names a variable (`EXPOSE $PORT`): the value depends on a build argument and is not guessed. */
  portFromVariable: boolean;
  /** The final stage has a HEALTHCHECK that is not `NONE`. */
  healthcheck: boolean;
}

/** The Dockerfile's instructions, comments dropped and continuation lines joined, as [KEYWORD, rest]. */
function instructions(text: string): [string, string][] {
  const out: [string, string][] = [];
  let pending = "";
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (pending !== "" && line.startsWith("#")) continue; // a comment inside a continued instruction
    const joined = pending === "" ? line : `${pending} ${line}`;
    if (joined.endsWith("\\")) {
      pending = joined.slice(0, -1).trimEnd();
      continue;
    }
    pending = "";
    const match = /^([A-Za-z]+)\s*(.*)$/.exec(joined);
    if (match) out.push([match[1]!.toUpperCase(), match[2]!]);
  }
  if (pending !== "") {
    const match = /^([A-Za-z]+)\s*(.*)$/.exec(pending);
    if (match) out.push([match[1]!.toUpperCase(), match[2]!]);
  }
  return out;
}

/**
 * What a Dockerfile says about the container it builds: the port it exposes and whether it has a health check. Only the
 * final stage counts (the one that runs). A port that is not a plain number (a variable, a range) is not guessed.
 */
export function parseDockerfile(text: string): DockerfileFacts {
  const all = instructions(text);
  let start = 0;
  all.forEach(([keyword], i) => {
    if (keyword === "FROM") start = i;
  });
  let expose: string | null = null;
  let healthcheck = false;
  for (const [keyword, rest] of all.slice(start)) {
    if (keyword === "EXPOSE") expose = rest;
    if (keyword === "HEALTHCHECK") healthcheck = !/^none\b/i.test(rest.trim());
  }
  if (expose === null) return { port: null, portFromVariable: false, healthcheck };
  const tokens = expose.split(/\s+/).filter((t) => t !== "");
  const first = tokens[0]?.replace(/^["']|["']$/g, "") ?? "";
  const plain = /^([0-9]{1,5})(?:\/(tcp|udp))?$/i.exec(first);
  if (plain) {
    const n = Number(plain[1]);
    // A UDP first port is skipped for the first TCP one; none at all is no port.
    if (plain[2]?.toLowerCase() !== "udp") return { port: n >= 1 && n <= 65535 ? n : null, portFromVariable: false, healthcheck };
    for (const token of tokens.slice(1)) {
      const t = /^([0-9]{1,5})(?:\/(tcp|udp))?$/i.exec(token.replace(/^["']|["']$/g, ""));
      if (t && t[2]?.toLowerCase() !== "udp") return { port: Number(t[1]) >= 1 && Number(t[1]) <= 65535 ? Number(t[1]) : null, portFromVariable: false, healthcheck };
    }
    return { port: null, portFromVariable: false, healthcheck };
  }
  return { port: null, portFromVariable: first.includes("$"), healthcheck };
}

// ---- where the Dockerfile is ----

/** A directory whose Dockerfile is conventionally built from the repository root. */
const ROOT_CONTEXT_DIRS: Record<string, true> = { docker: true, ".docker": true, deploy: true };

/**
 * The build context that goes with a Dockerfile's path in the repository: the repository root for a Dockerfile at the
 * root or in a conventional `docker/` or `deploy/` directory, otherwise the Dockerfile's own directory.
 */
export function contextOf(dockerfilePath: string): string {
  const dir = path.posix.dirname(dockerfilePath);
  return dir === "." || Object.hasOwn(ROOT_CONTEXT_DIRS, dir) ? "." : dir;
}

/**
 * The Dockerfile's path relative to the context, as the agent's `build.dockerfile` wants it; null when it is outside the
 * context. Not `path.relative`: this runs in the browser too, where Next's `path` stand-in resolves against a fake working
 * directory and drops the first character of a path relative to ".".
 */
export function dockerfileInContext(dockerfilePath: string, context: string): string | null {
  const file = path.posix.normalize(dockerfilePath);
  const dir = path.posix.normalize(context).replace(/\/$/, "");
  const rel = dir === "." ? file : file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
  return rel === null || rel === "" || rel === ".." || rel.startsWith("../") ? null : rel;
}

export interface TreeEntry {
  name: string;
  type: "file" | "dir";
}

/** Directories never searched for a Dockerfile: dependencies, build output, tooling. */
const SKIPPED_DIRS: Record<string, true> = {
  node_modules: true, vendor: true, dist: true, build: true, target: true, tests: true, test: true, docs: true, examples: true, ".git": true, ".github": true, ".venv": true,
};

/** At most this many subdirectories are listed: each one is a request to GitHub. */
export const MAX_SUBDIRS = 12;

/** The Dockerfile a repository can keep next to its own for Keelson's builder: the engine's classic one, without BuildKit-only syntax. */
export const KEELSON_DOCKERFILE = "Dockerfile.keelson";

/** The root files that are likely Dockerfiles, in order of preference, and the directories to look into. */
export function dockerfilePlaces(root: TreeEntry[]): { files: string[]; dirs: string[]; truncated: boolean } {
  const names = new Set(root.filter((e) => e.type === "file").map((e) => e.name));
  const files = [KEELSON_DOCKERFILE, "Dockerfile", "Dockerfile.prod"].filter((n) => names.has(n));
  const dirNames = root.filter((e) => e.type === "dir").map((e) => e.name);
  const conventional = ["docker", "deploy"].filter((d) => dirNames.includes(d));
  const others = dirNames.filter((d) => !conventional.includes(d) && !d.startsWith(".") && !Object.hasOwn(SKIPPED_DIRS, d)).sort();
  const dirs = [...conventional, ...others];
  return { files, dirs: dirs.slice(0, MAX_SUBDIRS), truncated: dirs.length > MAX_SUBDIRS };
}

/**
 * Orders the Dockerfiles found: Dockerfile.keelson (the variant a repository keeps for this agent's builder, which has no
 * BuildKit), Dockerfile, docker/Dockerfile, Dockerfile.prod, deploy/Dockerfile, then one-level subdirectories by name.
 */
export function orderDockerfiles(found: string[]): string[] {
  const rank = (p: string): number => {
    const known = [KEELSON_DOCKERFILE, "Dockerfile", "docker/Dockerfile", "Dockerfile.prod", "deploy/Dockerfile"].indexOf(p);
    return known >= 0 ? known : 5;
  };
  return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---- names and ports ----

/** What the agent accepts as an app name (and as part of the image `keelson-local/<name>`). */
export const APP_NAME = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
/** A pull request preview is named `<app>-pr-<n>` (n up to six digits) and a name is at most 63 characters. */
const MAX_NAME = 63;
const MAX_NAME_WITH_PREVIEWS = 53;

/** The repository's name as an app name: lowercase, anything else becomes a dash, no leading or trailing separator. */
export function slugName(repo: string): string {
  const base = repo.slice(repo.indexOf("/") + 1).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_WITH_PREVIEWS)
    .replace(/-+$/, "");
  return slug === "" ? "app" : slug;
}

/** The suggested name: the repository's, or with a number after it when an app has it already (`taken` says which). */
export function suggestName(repo: string, existing: readonly string[]): { name: string; taken: boolean } {
  const base = slugName(repo);
  const used = new Set(existing);
  if (!used.has(base)) return { name: base, taken: false };
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, MAX_NAME_WITH_PREVIEWS - String(n).length - 1)}-${n}`;
    if (!used.has(candidate)) return { name: candidate, taken: true };
  }
}

/** The host ports the agent's apps claim: `publish` entries (`[ip:]host:container[/proto]`) and `port.host`. */
export function usedHostPorts(apps: readonly AppConfig[]): Set<number> {
  const used = new Set<number>();
  for (const app of apps) {
    for (const mapping of app.publish ?? []) {
      const parts = mapping.split("/")[0]!.split(":");
      const host = Number(parts.length >= 3 ? parts[1] : parts[0]);
      if (Number.isInteger(host)) used.add(host);
    }
    for (const p of portParts(app.port).host ?? []) used.add(p);
  }
  return used;
}

export const FIRST_LOCAL_PORT = 8100;

/** The first port from 8100 that none of the agent's apps uses. What else listens on the server is not known. */
export function suggestHostPort(apps: readonly AppConfig[]): number {
  const used = usedHostPorts(apps);
  let port = FIRST_LOCAL_PORT;
  while (used.has(port) && port < 65535) port++;
  return port;
}

// ---- the review ----

export const DEFAULT_BUILD_MEMORY = "2g";
export const DEFAULT_BUILD_CPUS = 2;
export const DEFAULT_BUILD_TIMEOUT = "15m";

/** What the agent's configuration says that the form depends on. */
export interface ReviewContext {
  existingNames: string[];
  usedDomains: string[];
  usedHostPorts: number[];
  /** `caddy` only when the agent has a proxy section of the Caddy kind: domains are served only then. */
  proxy: "caddy" | "other" | "none";
  /** Apps that have a previews template. */
  previewApps: string[];
}

export function reviewContext(model: ConfigModel): ReviewContext {
  const apps = model.apps ?? [];
  const type: string | undefined = model.proxy?.type; // the model is the file's YAML: an empty or missing type is Caddy
  const proxy = model.proxy === undefined ? "none" : type === undefined || type === "" || type === "caddy" ? "caddy" : "other";
  return {
    existingNames: apps.map((a) => a.name),
    usedDomains: apps.flatMap((a) => a.domains ?? []).map((d) => d.toLowerCase()),
    usedHostPorts: [...usedHostPorts(apps)],
    proxy,
    previewApps: apps.filter((a) => a.previews !== undefined).map((a) => a.name),
  };
}

/** The review form as the browser sends it: every value is text. */
export interface ReviewInput {
  name: string;
  branch: string;
  /** The framework card the operator clicked: a preset, or `dockerfile` for the repository's own. Nothing is detected and nothing is the default. */
  preset: string;
  /** The preset's options as typed (blank = the default). Not read for the Dockerfile card, whose path and context are the two fields around it. */
  options: PresetOptions;
  /** The command to run in the new image before each deploy (a release step), blank for none. */
  release: string;
  /** The Dockerfile's path in the repository (the Dockerfile card). */
  dockerfile: string;
  /** The build context of the Dockerfile card; a preset's own is `options.context`. */
  context: string;
  port: string;
  exposure: string;
  domain: string;
  hostPort: string;
  healthPath: string;
  memory: string;
  cpus: string;
  timeout: string;
  /** Build on the server's own network (`build.network: host`), to reach a database on this server while building. */
  buildHostNetwork: boolean;
  /** The build uses the app's managed database (`build.database: true`): it only counts when a database is created with the project. */
  buildDatabase: boolean;
  envFile: string;
  buildOnPush: boolean;
  previews: boolean;
}

export type ReviewField = keyof ReviewInput;
/** A field of the form: its own name, or `options.<name>` for one of the preset's options. */
export type ReviewErrorKey = ReviewField | `options.${PresetField}`;
export type ReviewErrors = Partial<Record<ReviewErrorKey, string>>;

export interface Review {
  name: string;
  branch: string;
  preset: PresetId;
  /** The preset's options, trimmed; `{}` for the Dockerfile card. */
  options: PresetOptions;
  /** Blank for none. */
  release: string;
  /** Relative to the context, as the agent wants it (the Dockerfile card; empty for a preset). */
  dockerfile: string;
  context: string;
  port: number;
  exposure: { kind: "domain"; domain: string } | { kind: "local"; hostPort: number };
  healthPath: string;
  memory: string;
  cpus: number;
  timeout: string;
  buildHostNetwork: boolean;
  buildDatabase: boolean;
  envFile: string;
  buildOnPush: boolean;
  previews: boolean;
}

export type ReviewResult = { ok: true; review: Review } | { ok: false; errors: ReviewErrors };

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SIZE = /^([0-9]+)([kKmMgG]?)(?:[iI]?[bB])?$/;
const DURATION = /^([0-9]+)(s|m|h)$/;

/** A path inside the repository: relative, no `..`, no backslash or control character. Returns it clean, or null. */
function repoPath(text: string, allowRoot: boolean): string | null {
  const t = text.trim();
  if (t === "" || t.length > 300 || /[\\\u0000-\u001f\u007f]/.test(t) || t.startsWith("/")) return null;
  const clean = path.posix.normalize(t).replace(/\/$/, "");
  if (clean === ".." || clean.startsWith("../")) return null;
  if (clean === ".") return allowRoot ? "." : null;
  return clean;
}

function sizeBytes(text: string): number | null {
  const m = SIZE.exec(text);
  if (!m) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return Number(m[1]) * (unit === "g" ? 2 ** 30 : unit === "m" ? 2 ** 20 : unit === "k" ? 2 ** 10 : 1);
}

function seconds(text: string): number | null {
  const m = DURATION.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
}

function portNumber(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

/** The options with their text trimmed, so what is stored and shown is what was meant. */
function trimmedOptions(options: PresetOptions): PresetOptions {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(options)) {
    if (typeof v === "string") {
      if (v.trim() !== "") out[k] = v.trim();
    } else if (typeof v === "boolean") out[k] = v;
  }
  return out as PresetOptions;
}

/** Checks the review form against the agent's rules and what its configuration already holds. Every problem is reported, by field. */
export function validateReview(input: ReviewInput, context: ReviewContext): ReviewResult {
  const errors: ReviewErrors = {};
  const name = input.name.trim();
  if (!APP_NAME.test(name) || name.length > MAX_NAME) {
    errors.name = "Use lowercase letters and digits, with single dashes or underscores between them (up to 63 characters).";
  } else if (context.existingNames.includes(name)) {
    errors.name = `This server already has an app named ${name}. Choose another name, or link that app from its Source page.`;
  } else if (input.previews && name.length > MAX_NAME_WITH_PREVIEWS) {
    errors.name = "Names of apps with previews are at most 53 characters: the pull request number is added to it.";
  }

  const branch = input.branch.trim();
  if (!isBranchName(branch)) errors.branch = "That is not a valid branch name.";

  const preset: PresetId | null = isPresetId(input.preset) ? input.preset : null;
  if (preset === null) errors.preset = "Choose how the project is built: click one of the frameworks, or the repository's own Dockerfile.";
  const options: PresetOptions = preset !== null && preset !== "dockerfile" ? input.options : {};

  // The Dockerfile card: the Dockerfile and its context as detected and edited. A preset: its options, and the context among them.
  let dockerfilePath: string | null = "";
  let contextPath: string | null = ".";
  let relative = "";
  if (preset === "dockerfile") {
    dockerfilePath = repoPath(input.dockerfile, false);
    if (dockerfilePath === null) errors.dockerfile = "Give the Dockerfile's path in the repository, such as Dockerfile or docker/Dockerfile (no leading slash, no ..).";
    contextPath = repoPath(input.context === "" ? "." : input.context, true);
    if (contextPath === null) errors.context = "Give a directory of the repository, or . for its root (no leading slash, no ..).";
    if (dockerfilePath !== null && contextPath !== null) {
      const rel = dockerfileInContext(dockerfilePath, contextPath);
      if (rel === null) errors.dockerfile = `The Dockerfile must be inside the build context (${contextPath}).`;
      else relative = rel;
    }
  } else if (preset !== null) {
    for (const [field, message] of Object.entries(validatePresetOptions(preset, options))) errors[`options.${field as PresetField}`] = message;
    contextPath = repoPath((options.context ?? "").trim() === "" ? "." : (options.context ?? ""), true) ?? ".";
  }

  const defaultPort = preset === null ? null : getPreset(preset).defaultPort;
  const portText = input.port.trim() === "" && defaultPort !== null ? String(defaultPort) : input.port;
  const port = portNumber(portText);
  if (port === null) errors.port = input.port.trim() === "" ? "The container port is required: the port the app listens on inside the container." : "The port is a number from 1 to 65535.";
  else if (preset !== null) {
    const portProblem = validatePresetPort(preset, port);
    if (portProblem !== null) errors.port = portProblem;
  }

  let exposure: Review["exposure"] | null = null;
  const healthPath = input.healthPath.trim();
  if (input.exposure === "domain") {
    const domain = input.domain.trim().toLowerCase();
    if (context.proxy !== "caddy") {
      errors.exposure = context.proxy === "none" ? "This server's agent has no proxy section, so it cannot serve a domain. Use a local port." : "A domain is only offered with the Caddy proxy. Use a local port.";
    } else if (domain.length > 253 || !DOMAIN.test(domain)) {
      errors.domain = "That is not a valid host name, such as shop.example.com.";
    } else if (context.usedDomains.includes(domain)) {
      errors.domain = "Another app on this server already serves this domain.";
    } else {
      exposure = { kind: "domain", domain };
    }
  } else if (input.exposure === "local") {
    const hostPort = portNumber(input.hostPort);
    if (hostPort === null) errors.hostPort = "The local port is a number from 1 to 65535.";
    else if (context.usedHostPorts.includes(hostPort)) errors.hostPort = `Port ${hostPort} is already used by another app of this server.`;
    else exposure = { kind: "local", hostPort };
    // `publish` cannot go with `port`, which is how a generated image is told its port: on a local port it listens on its default.
    if (preset !== null && preset !== "dockerfile" && port !== null && defaultPort !== null && port !== defaultPort) {
      errors.port = `The ${getPreset(preset).label} image listens on ${defaultPort} when the app is on a local port. Use a domain to choose another port.`;
    }
    if (healthPath !== "") errors.healthPath = "A health path is only checked for apps served on a domain: the agent ignores it for a local port.";
  } else {
    errors.exposure = "Choose how the app is exposed.";
  }
  if (healthPath !== "" && errors.healthPath === undefined && (!healthPath.startsWith("/") || /\s/.test(healthPath) || healthPath.length > 200)) {
    errors.healthPath = "The health path starts with / and has no spaces, such as /healthz.";
  } else if (healthPath !== "" && errors.healthPath === undefined && preset !== null) {
    const problem = validatePresetHealthPath(preset, healthPath);
    if (problem !== null) errors.healthPath = problem;
  }

  const memory = input.memory.trim() === "" ? DEFAULT_BUILD_MEMORY : input.memory.trim();
  const bytes = sizeBytes(memory);
  if (bytes === null || bytes < 64 * 2 ** 20) errors.memory = "A size such as 2g or 512m, at least 64m.";
  const cpusText = input.cpus.trim() === "" ? String(DEFAULT_BUILD_CPUS) : input.cpus.trim();
  const cpus = /^[0-9]+(\.[0-9]+)?$/.test(cpusText) ? Number(cpusText) : NaN;
  if (!(cpus >= 0.1 && cpus <= 256)) errors.cpus = "A number of cores between 0.1 and 256.";
  const timeout = input.timeout.trim() === "" ? DEFAULT_BUILD_TIMEOUT : input.timeout.trim();
  const secs = seconds(timeout);
  if (secs === null || secs < 1 || secs > 3600) errors.timeout = "A duration such as 15m, at most 1h.";

  const envFile = input.envFile.trim();
  if (envFile !== "" && (!envFile.startsWith("/") || envFile.length > 1024 || /[\u0000-\u001f\u007f]/.test(envFile))) {
    errors.envFile = "An absolute path on the server, such as /etc/keelson/shop.env.";
  }

  if (input.previews && !context.previewApps.includes(name)) {
    errors.previews = "Previews need a previews: template for this app in the agent's apps file.";
  }

  const release = input.release.trim();
  const releaseProblem = commandProblem(release);
  if (releaseProblem !== null) errors.release = releaseProblem;

  if (Object.keys(errors).length > 0 || preset === null || exposure === null || port === null || dockerfilePath === null || contextPath === null) return { ok: false, errors };
  return {
    ok: true,
    review: { name, branch, preset, options: trimmedOptions(options), release, dockerfile: relative, context: contextPath, port, exposure, healthPath, memory, cpus, timeout, buildHostNetwork: input.buildHostNetwork === true, buildDatabase: input.buildDatabase === true, envFile, buildOnPush: input.buildOnPush, previews: input.previews },
  };
}

/**
 * The message shown under a field. Our own problems show after a first attempt; the server's (a name taken meanwhile)
 * always. Once the app is written nothing shows: the form is frozen and the agent's configuration holds the app, so
 * its name would otherwise be reported as taken by itself.
 */
export function visibleFieldError(
  field: ReviewErrorKey,
  state: { done: boolean; tried: boolean; local: ReviewErrors; server?: ReviewErrors },
): string | undefined {
  if (state.done) return undefined;
  return (state.tried ? state.local[field] : undefined) ?? state.server?.[field];
}

/** The image the agent tags a local build with: `<image>:<commit sha>`; nothing is pushed anywhere. */
export const LOCAL_IMAGE_PREFIX = "keelson-local/";

/** The name of the release step the "Run before each deploy" command becomes. */
export const RELEASE_STEP_NAME = "release";

/** The app the agent is asked to store: only what was decided in the review, no secret (the env file is a path on the server). */
export function buildAppConfig(review: Review): AppConfig {
  const app: AppConfig = {
    name: review.name,
    image: `${LOCAL_IMAGE_PREFIX}${review.name}`,
    build:
      review.preset === "dockerfile"
        ? { dockerfile: review.dockerfile, context: review.context, memory: review.memory, cpus: review.cpus, timeout: review.timeout }
        : { ...toBuildBlock(review.preset, review.options), memory: review.memory, cpus: review.cpus, timeout: review.timeout },
    // Docker's default is `no`, which leaves the app stopped after a reboot of the server or a restart of Docker.
    restart: "unless-stopped",
  };
  if (review.buildHostNetwork && app.build) app.build.network = "host";
  if (review.buildDatabase && app.build) app.build.database = true;
  if (review.envFile !== "") app.env_file = review.envFile;
  if (review.release !== "") app.release = { steps: [{ name: RELEASE_STEP_NAME, container: { command: ["sh", "-c", review.release] } }] };
  if (review.exposure.kind === "domain") {
    app.port = review.port;
    app.domains = [review.exposure.domain];
    if (review.healthPath !== "") app.health_path = review.healthPath;
  } else {
    app.publish = [`127.0.0.1:${review.exposure.hostPort}:${review.port}`];
  }
  return app;
}
