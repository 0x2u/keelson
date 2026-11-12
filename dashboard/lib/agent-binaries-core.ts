/** The CPU architectures an agent binary can be built for. */
export type AgentArch = "amd64" | "arm64";

/** The operating systems it can be built for: linux for servers, darwin for a Mac that connects out as a build machine. */
export type AgentOs = "linux" | "darwin";

/** `os` and `arch` as the connect command's `uname` answers normalise them, or null for a platform with no binary. */
export function parseAgentTarget(os: string | null, arch: string | null): { os: AgentOs; arch: AgentArch } | null {
  if ((os !== "linux" && os !== "darwin") || (arch !== "amd64" && arch !== "arm64")) return null;
  return { os, arch };
}

/** `uname -m` as agents are named: x86_64 -> amd64, aarch64 -> arm64. Anything else has no binary. */
export function archFromUname(machine: string): AgentArch | null {
  switch (machine.trim()) {
    case "x86_64":
    case "amd64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

/**
 * A version string as `scripts/build-agent.sh` and the image's `VERSION` build arg write it, from `git describe --tags --dirty`:
 * `v0.1.0` on a tag, `v0.1.0-4-g1a2b3c4` four commits after it, `-dirty` appended for uncommitted changes, and with a
 * pre-release tag `v0.2.0-rc.1-4-g1a2b3c4`. Anything else (`dev`, `dev-1a2b3c4`, a bare hash) is not a version and has no order.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated identifiers after the core (`rc.1`), empty for a release. */
  prerelease: string[];
  /** Commits since the tag, 0 on the tag itself. */
  commits: number;
  /** The abbreviated commit of a version between tags, else null. */
  hash: string | null;
  dirty: boolean;
}

const CORE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const AFTER_TAG = /-(\d+)-g([0-9a-f]{4,40})$/;

/** The version in `text`, or null when it is not `v?MAJOR.MINOR.PATCH[-prerelease][-N-gHASH][-dirty]`. */
export function parseVersion(text: string): ParsedVersion | null {
  let rest = text.trim();
  const dirty = rest.endsWith("-dirty");
  if (dirty) rest = rest.slice(0, -"-dirty".length);
  const after = AFTER_TAG.exec(rest);
  if (after) rest = rest.slice(0, after.index);
  const core = CORE.exec(rest);
  if (!core) return null;
  const [major, minor, patch] = [core[1], core[2], core[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: core[4] ? core[4].split(".") : [], commits: after ? Number(after[1]) : 0, hash: after ? after[2] : null, dirty };
}

/** Semver precedence of two pre-release lists: a release (empty) is above any pre-release, numbers are below words, a shorter list is below a longer one it starts. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const [na, nb] = [/^\d+$/.test(a[i]), /^\d+$/.test(b[i])];
    if (na && nb) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * How a server's agent stands against the one this dashboard carries.
 * - `current`: the same version, down to the commit.
 * - `older`: the agent is behind the dashboard: offer the update.
 * - `newer`: the agent is ahead of the dashboard: update the dashboard first, never offer a downgrade.
 * - `different`: they differ and no order can be told (a build named by a hash, two builds of one tag with the same commit count, one side not a version): offer the update, the operator knows which is newer.
 * - `unknown`: one side is missing.
 */
export type AgentUpdate = "current" | "older" | "newer" | "different" | "unknown";

export function agentUpdate(running: string, bundled: string | null): AgentUpdate {
  const have = running.trim();
  const carry = bundled?.trim() ?? "";
  if (have === "" || carry === "") return "unknown";
  if (have === carry) return "current";
  const [a, b] = [parseVersion(have), parseVersion(carry)];
  if (!a || !b) return "different";
  const order = a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease);
  if (order !== 0) return order < 0 ? "older" : "newer";
  // The same release: tell by commits since the tag. The same count on another commit (or one dirty) has no order.
  if (a.commits === b.commits) return a.hash === b.hash && a.dirty === b.dirty ? "current" : "different";
  return a.commits < b.commits ? "older" : "newer";
}

/** Whether the dashboard should offer to replace the agent: it is behind, or differs in a way that has no order. Never for an agent that is ahead. */
export function offersUpdate(state: AgentUpdate): boolean {
  return state === "older" || state === "different";
}

/** The release page of a version that is a published tag (`v0.1.0`, `v0.2.0-rc.1`), or null for a build between tags, a dirty one or a hash. */
export function releaseNotesUrl(version: string | null): string | null {
  const tag = version?.trim() ?? "";
  const parsed = parseVersion(tag);
  if (!parsed || !tag.startsWith("v") || parsed.hash !== null || parsed.dirty) return null;
  return `https://github.com/0x2u/keelson/releases/tag/${tag}`;
}
