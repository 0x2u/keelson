import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { AgentArch, AgentOs } from "@/lib/agent-binaries-core";

export interface AgentBinary {
  os: AgentOs;
  arch: AgentArch;
  path: string;
  size: number;
  /** Hex SHA-256: the server checks it after the upload. */
  sha256: string;
}

/** Where the binaries live: next to the dashboard in the image, or wherever KEELSON_AGENT_BIN_DIR says. */
export function binaryDir(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.KEELSON_AGENT_BIN_DIR ?? "./agent-bin");
}

/**
 * The version of this dashboard: the image bakes it in (KEELSON_DASHBOARD_VERSION, from the VERSION build arg, a release tag
 * such as v0.1.0). A dashboard run from a checkout has none and says "dev".
 */
export function dashboardVersion(): string {
  return process.env.KEELSON_DASHBOARD_VERSION?.trim() || "dev";
}

/** The version of the agent this dashboard carries (the VERSION file written next to the binaries), or null. */
export function bundledAgentVersion(): string | null {
  try {
    return readFileSync(path.join(binaryDir(), "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** A binary with what identifies the file it was read from: a rebuilt binary can have the very same size. */
type Cached = AgentBinary & { modified: number };

const cache: Partial<Record<`${AgentOs}-${AgentArch}`, Cached>> = {};

/**
 * The agent binary this dashboard ships for a platform (linux unless said), with its checksum. The dashboard installs
 * its own version of the agent: nothing is downloaded from the internet, and the two always match.
 */
export function agentBinary(arch: AgentArch, os: AgentOs = "linux"): AgentBinary {
  const name = `${os}-${arch}` as const;
  const file = path.join(binaryDir(), `keelson-agent-${name}`);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new Error(`this dashboard has no agent binary for ${name} (expected ${file}): build it with "pnpm run agent-bin" in dashboard/ (or scripts/build-agent.sh), then try again`);
  }
  const cached = cache[name];
  if (cached && cached.size === stat.size && cached.modified === stat.mtimeMs && cached.path === file) return cached;
  const binary: Cached = { os, arch, path: file, size: stat.size, modified: stat.mtimeMs, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  cache[name] = binary;
  return binary;
}

/** The download of a binary: the checksum goes in a header so a script can verify what it fetched. */
export function binaryResponse(binary: AgentBinary): Response {
  return new Response(Readable.toWeb(createReadStream(binary.path)) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(binary.size),
      "Content-Disposition": `attachment; filename="keelson-agent-${binary.os}-${binary.arch}"`,
      "X-Checksum-Sha256": binary.sha256,
      "Cache-Control": "no-store",
    },
  });
}
