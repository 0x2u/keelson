import {
  HIDDEN,
  type AppConfig,
  type BuildConfig,
  type BuildLimits,
  type BuildRequestBody,
  type BuildSource,
  type BuildVarName,
} from "@/lib/agent-types";
import { portParts } from "@/lib/app-config-core";
import { splitRef } from "@/lib/image-ref-core";
import { platformFor } from "@/lib/machine-core";
import { formatBytes, type ServerStats } from "@/lib/server-stats-core";

// An app built on a server that is not its own is a request to that server (POST /v1/builds): the app's `build:` block,
// read from the app's own server, plus the source. Pure: what the request carries, what the builder's limits refuse, and
// what is said when something stored on the app's server cannot travel with it.

const KIB = 1024;
const SIZE_UNITS: Record<string, number> = { "": 1, k: KIB, m: KIB ** 2, g: KIB ** 3 };
const DURATION_UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

/** Bytes of a size as the apps file writes it ("3g", "512m", "2048"); null when it is not one. */
export function parseSize(text: string | undefined): number | null {
  const m = /^\s*(\d+)\s*([kmg]?)(?:i?b)?\s*$/i.exec(text ?? "");
  return m ? Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] ?? 1) : null;
}

/** Seconds of a duration as the apps file writes it ("30m", "1h30m", "90s"); null when it is not one. */
export function parseDurationSeconds(text: string | undefined): number | null {
  const whole = /^\s*((?:\d+(?:\.\d+)?(?:ms|s|m|h))+)\s*$/.exec(text ?? "");
  if (!whole) return null;
  let total = 0;
  for (const part of whole[1].matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(part[1]) * DURATION_UNITS[part[2]];
  return total;
}

/**
 * The first limit of the builder that the build block asks more than, in words that name it; null when the block is within
 * all of them. Only what the block states is compared: a value it leaves out is the agent's default, which the agent holds
 * to its own limits. `network: host` is a limit too (build_limits.host_network); a named network is not: it names a network of
 * the app's own server and never travels (see buildRequestFor).
 */
export function limitRefusal(build: BuildConfig, limits: BuildLimits): string | null {
  const memory = parseSize(build.memory);
  if (memory !== null && limits.memory > 0 && memory > limits.memory) return `build.memory ${build.memory} is above the build limit memory (${formatBytes(limits.memory)})`;
  if (build.cpus !== undefined && build.cpus > limits.cpus) return `build.cpus ${build.cpus} is above the build limit cpus (${limits.cpus})`;
  const timeout = parseDurationSeconds(build.timeout);
  if (timeout !== null && timeout > limits.timeout_seconds) return `build.timeout ${build.timeout} is above the build limit timeout (${formatDuration(limits.timeout_seconds)})`;
  const source = parseSize(build.max_source);
  if (source !== null && source > limits.max_source) return `build.max_source ${build.max_source} is above the build limit max_source (${formatBytes(limits.max_source)})`;
  const allowed = new Set(limits.source_hosts.map((h) => h.toLowerCase()));
  const outside = (build.source_hosts ?? []).filter((h) => !allowed.has(h.toLowerCase()));
  if (outside.length > 0) return `build.source_hosts ${outside.join(", ")} is not among the build limit source_hosts (${limits.source_hosts.join(", ") || "none"})`;
  if (build.network === "host" && !limits.host_network) return "build.network host is not allowed (build_limits.host_network: true)";
  return null;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** One line of what a server's build limits allow: "up to 2 GB of memory · 4 CPUs · 30 min · sources up to 1 GB". */
export function describeLimits(limits: BuildLimits): string {
  const parts = [
    limits.memory > 0 ? `up to ${formatBytes(limits.memory)} of memory` : "no memory ceiling",
    `up to ${limits.cpus} ${limits.cpus === 1 ? "CPU" : "CPUs"}`,
    `${formatDuration(limits.timeout_seconds)} per build`,
    `sources up to ${formatBytes(limits.max_source)}`,
  ];
  if (limits.host_network) parts.push("host network allowed");
  return parts.join(" · ");
}

/**
 * The platform the image is built for: the one the app's block sets, else the target's, when the builder is of another
 * architecture (or does not say). Undefined leaves it to the builder's engine. The target's architecture unknown: nothing to say.
 */
export function buildPlatform(block: BuildConfig, targetArch: string | undefined, builderArch: string | undefined): string | undefined {
  if (block.platform !== undefined && block.platform !== "") return block.platform;
  if (targetArch === undefined || builderArch === targetArch) return undefined;
  return platformFor(targetArch);
}

/** Said under a builder of another architecture than the target: the image is made for the target, which the builder does through emulation. */
export function emulationNote(builderArch: string | undefined, targetArch: string | undefined, platform: string | undefined): string | null {
  if (platform !== undefined && platform !== "") return null;
  if (builderArch === undefined || targetArch === undefined || builderArch === targetArch) return null;
  return `The image is built for linux/${targetArch} (where it runs) on a linux/${builderArch} server: Docker does that through emulation, which is slower.`;
}

export type BuildRequestResult = { ok: true; request: BuildRequestBody; hiddenArgs: string[] } | { ok: false; error: string };

/**
 * The request that has another server build `app`: its `build:` block as the target's configuration API gave it, without
 * what names things of the app's own server (`database`, a named `network`), for the platform of the app's server. A build
 * that asks for the host's network (`network: host`) goes with it only to a builder that allows it (build_limits.host_network):
 * the app's DATABASE_URL may be a tunnel on the builder's own host. A builder that does not allow it refuses here, before
 * anything is sent. Build arguments whose values the API hides (`<hidden>`: secrets are write-only) are NOT sent and are named
 * in `hiddenArgs`: the builder keeps its own stored build variables for the app (see notSentWarning).
 */
export function buildRequestFor(
  app: AppConfig,
  o: { sha: string; source: BuildSource; targetArch: string | undefined; builderArch: string | undefined; builder: { name: string; limits: BuildLimits } },
): BuildRequestResult {
  const block = app.build;
  if (block === undefined) return { ok: false, error: `${app.name} has no build: block in its apps file, so there is nothing to ask another server to build` };
  const hostNetwork = block.network === "host";
  if (hostNetwork && !o.builder.limits.host_network) return { ok: false, error: `${o.builder.name} does not allow host-network builds (build_limits.host_network: true)` };
  // `only` is gone from the model; `database` and a named network name things of the app's own server.
  const { network: _network, database: _database, args, ...rest } = block; // eslint-disable-line @typescript-eslint/no-unused-vars
  const shown = Object.entries(args ?? {}).filter(([, v]) => v !== HIDDEN);
  const hiddenArgs = Object.entries(args ?? {})
    .filter(([, v]) => v === HIDDEN)
    .map(([k]) => k);
  const platform = buildPlatform(block, o.targetArch, o.builderArch);
  const build: BuildConfig = { ...rest, ...(hostNetwork ? { network: "host" } : {}), ...(shown.length > 0 ? { args: Object.fromEntries(shown) } : {}), ...(platform !== undefined ? { platform } : {}) };
  return {
    ok: true,
    hiddenArgs,
    request: {
      app: app.name,
      image: splitRef(app.image).repository,
      sha: o.sha,
      source: o.source,
      build,
      // A framework preset writes these into the image it builds, and the builder wants them in the request too.
      ...(block.preset !== undefined && portParts(app.port).container !== undefined ? { port: portParts(app.port).container } : {}),
      ...(block.preset !== undefined && app.health_path !== undefined ? { health_path: app.health_path } : {}),
    },
  };
}

/** What stays on the app's server when it is built elsewhere: its stored build variables (never used there) and the build arguments its configuration hides (never readable). */
export interface NotSent {
  /** Names of the variables stored (write-only) on the app's own server and flagged for build time. */
  stored: string[];
  /** Names of `build.args` whose values the configuration API hides: they are left out of the request. */
  hidden: string[];
}

/** The anchor of the section of the Source page where the builder's build variables are kept. */
export const BUILD_VARS_ANCHOR = "build-variables";

/** The names a build elsewhere needs from the builder's build variables and does not find there: what the app has stored for build time on its own server, and its hidden build.args. */
export function missingOnBuilder(n: NotSent, onBuilder: string[]): string[] {
  const have = new Set(onBuilder);
  return [...new Set([...n.stored, ...n.hidden])]
    .filter((k) => !have.has(k))
    .sort();
}

export interface BuildWarning {
  title: string;
  body: string;
  /** Where to set what is missing: the section of the Source page for the builder's build variables. */
  href: string;
}

/**
 * The warning for choosing (or building on) another server for an app whose own server stores build values that the builder
 * does not have (`onBuilder` are the names of its build variables for the app); null when it has them all or there are none.
 */
export function notSentWarning(
  n: NotSent,
  o: { app: string; ownName: string; buildServer: string; onBuilder: string[] },
): BuildWarning | null {
  const have = new Set(o.onBuilder);
  const stored = [...new Set(n.stored)].filter((k) => !have.has(k)).sort();
  const hidden = [...new Set(n.hidden)].filter((k) => !have.has(k)).sort();
  if (stored.length === 0 && hidden.length === 0) return null;
  const them = stored.length + hidden.length === 1 ? "it" : "them";
  const parts: string[] = [];
  if (stored.length > 0) {
    parts.push(`The build variables of ${o.app} (${stored.join(", ")}) are stored on ${o.ownName}, and values are write-only: a build on ${o.buildServer} does not use them. Only the build arguments of its build: block travel with the request.`);
  }
  if (hidden.length > 0) {
    parts.push(`${hidden.join(", ")} in build.args ${hidden.length === 1 ? "is a secret that the configuration hides, so it is" : "are secrets that the configuration hides, so they are"} not sent either.`);
  }
  parts.push(
    `${o.buildServer} has no build variable of ${them === "it" ? "that name" : "those names"} for ${o.app}: put ${them} in the build variables of ${o.buildServer}, or build on ${o.ownName} itself.`,
  );
  return {
    title: "Build values are not sent",
    body: parts.join(" "),
    href: `#${BUILD_VARS_ANCHOR}`,
  };
}

/** What the builder's build variables were read as: their names, or why they could not be read. */
export type BuildVarsRead = { names: BuildVarName[] } | { error: string };

/** What the section "Build variables on <builder>" shows for one builder. */
export interface BuildVarsView {
  title: string;
  /** What these variables are and how they are used: always shown. */
  intro: string;
  /** Says plainly that the app's own stored build variables on its server are not used by a build elsewhere, and names them; null when it has none. */
  ownNote: string | null;
  /** Why the names could not be read (an agent too old, not answering); null when they were. */
  readError: string | null;
  /** The names stored on the builder for the app. */
  names: BuildVarName[];
  /** The names the app wants at build time that the builder does not have: "Copy the names" offers them as placeholders to fill. Never values. */
  missing: string[];
}

export function buildVarsView(o: {
  app: string;
  ownName: string;
  builder: string;
  read: BuildVarsRead;
  notSent: NotSent;
}): BuildVarsView {
  const names = "names" in o.read ? o.read.names : [];
  const own = [...new Set(o.notSent.stored)].sort();
  return {
    title: `Build variables on ${o.builder}`,
    intro: `Values ${o.builder} gives to the build of ${o.app} as build arguments (docker build --build-arg): a database URL the build needs, a public key. Write-only: once saved a value is never shown again, and it stays on ${o.builder}. They are baked into the image's history, like any build argument.`,
    ownNote:
      own.length === 0
        ? null
        : `The build variables of ${o.app} stored on ${o.ownName} (${own.join(", ")}) are NOT used by a build on ${o.builder}: values are write-only and never leave ${o.ownName}. Set the ones the build needs here.`,
    readError: "error" in o.read ? o.read.error : null,
    names,
    missing:
      "error" in o.read
        ? []
        : missingOnBuilder(
            o.notSent,
            names.map((n) => n.name),
          ),
  };
}

/** A server the app could be built on, with why it cannot be chosen (if so) and what to know before choosing it. */
export interface BuildServerChoice {
  serverId: string;
  name: string;
  stats: ServerStats;
  /** Why it cannot be chosen; null when it can. */
  disabled: string | null;
  /** Said under it without stopping the choice. */
  note: string | null;
}

/**
 * The servers other than the app's own, as places to build it. One that does not answer, has no deploy secret here, has an
 * agent without `/v1/builds` (no `build` in its system report: "update the agent"), or would refuse the app's block (a limit
 * named) is listed and cannot be chosen.
 */
export function buildChoices(servers: { id: string; name: string; canDeploy: boolean; stats: ServerStats }[], block: BuildConfig | undefined, targetArch: string | undefined): BuildServerChoice[] {
  return servers.map((s): BuildServerChoice => {
    const choice = (disabled: string | null, note: string | null = null): BuildServerChoice => ({ serverId: s.id, name: s.name, stats: s.stats, disabled, note });
    if (!s.canDeploy) return choice(`${s.name} has no deploy secret in this dashboard: builds are signed with it.`);
    if (!s.stats.online) return choice(`${s.name} is not answering: start its agent, then choose it.`);
    if (s.stats.build === undefined) return choice(`Update the agent on ${s.name}: it cannot build for other servers yet.`);
    if (block === undefined) return choice("This app has no build: block in its apps file, so there is nothing to ask another server to build.");
    const refused = limitRefusal(block, s.stats.build);
    if (refused !== null) return choice(`${s.name} refuses this build: ${refused}.`);
    return choice(null, emulationNote(s.stats.arch, targetArch, block.platform));
  });
}
