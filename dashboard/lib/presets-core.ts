/**
 * The build presets the operator picks from when a project is created: Next.js, Node.js, Vite, static files, or the
 * repository's own Dockerfile. A preset is CHOSEN, never detected from the repository. Each entry says what to show
 * (label, description, icon, default port and health path, the fields it reads) and turns the options into the `build:`
 * block the agent's apps file takes; the agent generates the Dockerfile (see docs/reference/builds.md).
 *
 * The validation mirrors the agent's (agent/internal/config/presets.go) so a refusal shows next to the field instead of
 * as an agent error after the save; the agent still validates everything itself. Pure: no database, no network.
 */

import type { BuildConfig } from "@/lib/agent-types";

export type PresetId = "nextjs" | "node" | "vite" | "static" | "dockerfile";

/** In the order the cards are shown. */
export const PRESET_IDS: readonly PresetId[] = ["nextjs", "node", "vite", "static", "dockerfile"];

/** The options a preset may read. `context` is the repository subdirectory that is built (the agent's `build.context`). */
export type PresetField =
  | "context"
  | "install"
  | "build_command"
  | "start"
  | "output_dir"
  | "node"
  | "spa"
  | "standalone"
  | "dockerfile"
  | "target";

/** What the operator typed: text fields as strings (blank = the default), the two switches as booleans. */
export interface PresetOptions {
  context?: string;
  install?: string;
  build_command?: string;
  start?: string;
  output_dir?: string;
  node?: string;
  spa?: boolean;
  standalone?: boolean;
  dockerfile?: string;
  target?: string;
}

/** Names of lucide-react icons, so this module needs no React. */
export type PresetIcon = "Triangle" | "Server" | "Zap" | "Globe" | "Container";

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  icon: PresetIcon;
  /** The container port the generated image listens on when the app has none; null for a Dockerfile (asked, never guessed). */
  defaultPort: number | null;
  /** The health path to suggest; the generated images' HEALTHCHECK follows it. Empty: none suggested. */
  defaultHealthPath: string;
  /** The options this preset reads. `visibleFields` narrows it by what is already typed. */
  fields: readonly PresetField[];
  /** What a blank option means, to pre-fill or show as a placeholder (the agent applies the same). */
  defaults: Readonly<{ node?: string; output_dir?: string; spa?: boolean; standalone?: boolean }>;
  /** What a blank command option does (it depends on the lockfile), for a placeholder. */
  placeholders: Readonly<Partial<Record<PresetField, string>>>;
}

export const DEFAULT_NODE = "22";
export const DEFAULT_OUTPUT_DIR = "dist";
/** The oldest Node.js major version the agent accepts. */
export const MIN_NODE = 18;
export const MAX_COMMAND_BYTES = 1024;

const INSTALL_PLACEHOLDER = "by lockfile: pnpm / yarn --frozen-lockfile, npm ci, else npm install";

const PRESETS: Readonly<Record<PresetId, Preset>> = {
  nextjs: {
    id: "nextjs",
    label: "Next.js",
    description: "Builds with next build and serves with next start. Turn on standalone for a much smaller image.",
    icon: "Triangle",
    defaultPort: 3000,
    defaultHealthPath: "/",
    fields: ["context", "install", "build_command", "start", "node", "standalone"],
    defaults: { node: DEFAULT_NODE, standalone: false },
    placeholders: { install: INSTALL_PLACEHOLDER, build_command: "<package manager> run build", start: 'next start -p "$PORT"' },
  },
  node: {
    id: "node",
    label: "Node.js",
    description: "A Node.js server: installs from the lockfile, runs the build script if there is one, then npm start.",
    icon: "Server",
    defaultPort: 3000,
    defaultHealthPath: "/",
    fields: ["context", "install", "build_command", "start", "node"],
    defaults: { node: DEFAULT_NODE },
    placeholders: { install: INSTALL_PLACEHOLDER, build_command: "<package manager> run build, if package.json has a build script", start: "<package manager> start" },
  },
  vite: {
    id: "vite",
    label: "Vite",
    description: "A single-page app: built with Node.js, served by nginx. Unknown paths answer index.html.",
    icon: "Zap",
    defaultPort: 8080,
    defaultHealthPath: "/",
    fields: ["context", "install", "build_command", "output_dir", "node", "spa"],
    defaults: { node: DEFAULT_NODE, output_dir: DEFAULT_OUTPUT_DIR, spa: true },
    placeholders: { install: INSTALL_PLACEHOLDER, build_command: "<package manager> run build" },
  },
  static: {
    id: "static",
    label: "Static files",
    description: "HTML, CSS and JavaScript served by nginx as they are, or built first by a command you give.",
    icon: "Globe",
    defaultPort: 8080,
    defaultHealthPath: "/",
    fields: ["context", "build_command", "install", "output_dir", "node", "spa"],
    defaults: { node: DEFAULT_NODE, output_dir: DEFAULT_OUTPUT_DIR, spa: true },
    placeholders: { install: INSTALL_PLACEHOLDER, build_command: "none: the files are served as they are" },
  },
  dockerfile: {
    id: "dockerfile",
    label: "Dockerfile",
    description: "The repository's own Dockerfile, built as it is.",
    icon: "Container",
    defaultPort: null,
    defaultHealthPath: "",
    fields: ["context", "dockerfile", "target"],
    defaults: {},
    placeholders: { dockerfile: "Dockerfile" },
  },
};

/** The presets, in card order. */
export const PRESET_LIST: readonly Preset[] = PRESET_IDS.map((id) => PRESETS[id]);

export function isPresetId(v: unknown): v is PresetId {
  return typeof v === "string" && (PRESET_IDS as readonly string[]).includes(v);
}

export function getPreset(id: PresetId): Preset {
  return PRESETS[id];
}

/** The card an existing `build:` block corresponds to: its preset, or the Dockerfile card without one. */
export function presetOf(build: BuildConfig | undefined): PresetId {
  return isPresetId(build?.preset) ? build.preset : "dockerfile";
}

/** The options of an existing `build:` block, as a form holds them (for editing). */
export function optionsFromBuild(build: BuildConfig | undefined): PresetOptions {
  const b = build ?? {};
  const o: PresetOptions = {};
  for (const k of ["context", "install", "build_command", "start", "output_dir", "dockerfile", "target"] as const) {
    if (typeof b[k] === "string" && b[k] !== "") o[k] = b[k];
  }
  if (b.node !== undefined && b.node !== "") o.node = String(b.node);
  if (typeof b.spa === "boolean") o.spa = b.spa;
  if (typeof b.standalone === "boolean") o.standalone = b.standalone;
  return o;
}

/**
 * The options a preset reads right now. The static preset only builds when it has a build command, so its install
 * command and Node.js version appear (and count) only then, as the agent refuses them without one.
 */
export function visibleFields(id: PresetId, options: PresetOptions): readonly PresetField[] {
  const fields = PRESETS[id].fields;
  if (id === "static" && (options.build_command ?? "").trim() === "") {
    return fields.filter((f) => f !== "install" && f !== "node");
  }
  return fields;
}

/** Whether the generated image builds the site with Node.js first (everything but a static site with no build command). */
export function hasBuildStage(id: PresetId, options: PresetOptions): boolean {
  return id !== "static" || (options.build_command ?? "").trim() !== "";
}

/**
 * The agent's `build:` block for the chosen preset: only what differs from a blank option, and only the fields the
 * preset reads. The Dockerfile card gives a block without `preset`, as before. Call it with validated options.
 */
export function toBuildBlock(id: PresetId, options: PresetOptions): BuildConfig {
  const block: BuildConfig = {};
  if (id !== "dockerfile") block.preset = id;
  const shown = new Set<PresetField>(visibleFields(id, options));
  const text = (k: PresetField): string => ((options as Record<string, unknown>)[k] as string | undefined)?.trim() ?? "";

  const context = text("context");
  if (shown.has("context") && context !== "" && cleanPath(context) !== ".") block.context = cleanPath(context) ?? context;
  if (shown.has("dockerfile") && text("dockerfile") !== "") block.dockerfile = text("dockerfile");
  if (shown.has("target") && text("target") !== "") block.target = text("target");
  for (const k of ["install", "build_command", "start"] as const) {
    if (shown.has(k) && text(k) !== "") block[k] = text(k);
  }
  if (shown.has("node") && text("node") !== "") block.node = text("node");
  if (shown.has("output_dir") && text("output_dir") !== "") block.output_dir = cleanPath(text("output_dir")) ?? text("output_dir");
  if (shown.has("spa") && options.spa === false) block.spa = false;
  if (shown.has("standalone") && options.standalone === true) block.standalone = true;
  return block;
}

/** The problems of the options, by field. */
export type PresetErrors = Partial<Record<PresetField, string>>;

/** Errors by field, in the agent's own words where it has them. Only the fields the preset reads are checked. */
export function validatePresetOptions(id: PresetId, options: PresetOptions): PresetErrors {
  const errors: PresetErrors = {};
  const shown = new Set<PresetField>(visibleFields(id, options));
  const text = (k: PresetField): string => ((options as Record<string, unknown>)[k] as string | undefined) ?? "";

  if (shown.has("context")) {
    const e = repositoryPathError("context", text("context"));
    if (e) errors.context = e;
  }
  if (shown.has("dockerfile") && text("dockerfile").trim() !== "") {
    const e = repositoryPathError("dockerfile", text("dockerfile"));
    if (e) errors.dockerfile = e;
    else if (cleanPath(text("dockerfile")) === ".") errors.dockerfile = "The Dockerfile must name a file.";
  }
  if (shown.has("target") && text("target").trim() !== "" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(text("target").trim())) {
    errors.target = "A stage name: letters, digits, . _ -, starting with a letter or digit.";
  }
  for (const k of ["install", "build_command", "start"] as const) {
    if (!shown.has(k)) continue;
    const e = commandError(text(k));
    if (e) errors[k] = e;
  }
  if (shown.has("node") && text("node").trim() !== "") {
    const v = text("node").trim();
    if (!/^[1-9][0-9]$/.test(v) || Number(v) < MIN_NODE) {
      errors.node = `A Node.js major version, ${MIN_NODE} or later, such as ${DEFAULT_NODE}.`;
    }
  }
  if (shown.has("output_dir")) {
    const e = outputDirError(text("output_dir"), hasBuildStage(id, options));
    if (e) errors.output_dir = e;
  }
  return errors;
}

/** The port of the app against the preset: nginx runs as a regular user, so the Vite and static images need 1024 or more. */
export function validatePresetPort(id: PresetId, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "A port between 1 and 65535.";
  if ((id === "static" || id === "vite") && port < 1024) {
    return `Port ${port} is below 1024: the ${PRESETS[id].label} image runs nginx as a regular user, so it needs 1024 or more (such as 8080).`;
  }
  return null;
}

/** The health path against the preset: the generated image carries it in its HEALTHCHECK, so it may only hold plain URL characters. */
export function validatePresetHealthPath(id: PresetId, path: string): string | null {
  if (path === "") return null;
  if (!path.startsWith("/") || /\s/.test(path)) return "A path starting with / and holding no spaces.";
  if (id !== "dockerfile" && !/^\/[A-Za-z0-9._~/%?&=:@+,-]*$/.test(path)) {
    return "Letters, digits and . _ ~ / % ? & = : @ + , - only: the generated image's health check carries it.";
  }
  return null;
}

// ----- the agent's rules -----

/** Go's path.Clean for a relative path: "" and "." elements dropped, ".." resolved. Null when the path climbs above where it starts. */
function cleanPath(p: string): string | null {
  const out: string[] = [];
  for (const el of p.trim().split("/")) {
    if (el === "" || el === ".") continue;
    if (el === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(el);
  }
  return out.length === 0 ? "." : out.join("/");
}

/** The agent's `cleanBuildPath`: relative to the repository (or the context), no backslash or NUL, never leaving it. Blank is the default. */
function repositoryPathError(key: string, value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (/[\\\0]/.test(v) || v.startsWith("/")) return `The ${key} must be a relative path inside the repository.`;
  if (cleanPath(v) === null) return `The ${key} must not leave the repository (no ..).`;
  return null;
}

function outputDirError(value: string, built: boolean): string | null {
  const v = value.trim();
  if (v === "") return null;
  const e = repositoryPathError("output directory", v);
  if (e) return e;
  const dir = cleanPath(v) ?? v;
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) return "Letters, digits and . _ / - only.";
  if (dir === "." && built) return "Name the directory the build writes: the whole project cannot be served when it is built.";
  return null;
}

/** A command goes through `sh -c` as one line of at most 1024 bytes, with no control characters. */
function commandError(value: string): string | null {
  if (value === "") return null;
  if (value.trim() === "") return "Blank: leave it empty for the default.";
  if (new TextEncoder().encode(value).length > MAX_COMMAND_BYTES) return `At most ${MAX_COMMAND_BYTES} bytes.`;
  if (/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/.test(value)) return "One line, no control characters: a newline or NUL byte is refused.";
  return null;
}

/** Why a one-line command (a preset's, or the one run before each deploy) is refused, or null. Blank is allowed. */
export function commandProblem(value: string): string | null {
  return commandError(value);
}

/** The keys of a `build:` block that the preset options own: everything else (limits, `args`, `max_source`, `source_hosts`) is kept as it is. */
const OPTION_KEYS: readonly (keyof BuildConfig)[] = ["preset", "install", "build_command", "start", "output_dir", "node", "spa", "standalone", "dockerfile", "context", "target"];

/**
 * The `build:` block after editing the preset and its options: the block the form read, with what the options own
 * replaced by `toBuildBlock` and everything else left exactly as it was, so saving never drops a setting the form does not show.
 */
export function mergeBuild(original: BuildConfig | undefined, id: PresetId, options: PresetOptions): BuildConfig {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(original ?? {})) if (!(OPTION_KEYS as readonly string[]).includes(k)) kept[k] = v;
  return { ...toBuildBlock(id, options), ...kept } as BuildConfig;
}

/** What the app page says about how an app is built: the preset, or the Dockerfile, with the options that differ from the defaults. Null without a `build:` block. */
export function describeBuild(build: BuildConfig | undefined): { label: string; details: string[] } | null {
  if (build === undefined) return null;
  const id = presetOf(build);
  const preset = PRESETS[id];
  const details: string[] = [];
  const o = optionsFromBuild(build);
  const shown = new Set<PresetField>(visibleFields(id, o));
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== "") details.push(`${label}: ${value}`);
  };
  if (shown.has("context")) add("Directory", o.context);
  if (id === "dockerfile") {
    add("Dockerfile", o.dockerfile ?? "Dockerfile");
    add("Stage", o.target);
  } else {
    add("Install", o.install);
    add("Build", o.build_command);
    add("Start", o.start);
    if (shown.has("output_dir")) add("Output", o.output_dir ?? DEFAULT_OUTPUT_DIR);
    if (shown.has("node")) add("Node.js", o.node ?? DEFAULT_NODE);
    if (shown.has("spa") && o.spa === false) details.push("Single-page fallback off");
    if (shown.has("standalone") && o.standalone === true) details.push("Standalone output");
  }
  return { label: id === "dockerfile" ? "Repository Dockerfile" : `${preset.label} preset`, details };
}
