import type { BuildLimits, SystemInfo } from "@/lib/agent-types";

/** What tells two servers apart at a glance when choosing where something is built or runs. Plain data: it crosses to the browser. */
export interface ServerStats {
  /** The agent answered. */
  online: boolean;
  cpus?: number;
  /** The load average over one minute. */
  load1?: number;
  /** Bytes. `memAvailable` is what a new process can get without swapping. */
  memTotal?: number;
  memAvailable?: number;
  diskTotal?: number;
  diskFree?: number;
  /** The engine's platform, as `/v1/system` reports it. */
  os?: string;
  arch?: string;
  /** What the server accepts as a build request (its `build_limits`); absent on a server that cannot build for the dashboard (an older agent). */
  build?: BuildLimits;
}

export const OFFLINE: ServerStats = { online: false };

/** The stats of an agent's answer; null (an agent that did not answer, or is too old for /v1/system) is offline. */
export function statsFromSystem(sys: SystemInfo | null): ServerStats {
  if (sys === null) return OFFLINE;
  const h = sys.host;
  return {
    online: true,
    cpus: h.cpus,
    load1: h.load?.one,
    memTotal: h.memory?.total,
    memAvailable: h.memory?.available,
    diskTotal: h.disk?.total,
    diskFree: h.disk?.free,
    os: sys.os,
    arch: sys.arch,
    ...(sys.build?.enabled ? { build: sys.build.limits } : {}),
  };
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** "2.8 GB", "640 MB": binary units written the way operators read them. */
export function formatBytes(n: number): string {
  if (n >= 10 * GIB) return `${Math.round(n / GIB)} GB`;
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / MIB))} MB`;
}

/** A size such as "3g", "512m" or "2048" (bytes) as the agent's `build.memory` writes it; the agent's default (2g) when empty or unreadable. */
export function parseBuildMemory(text: string | undefined): number {
  const m = /^\s*(\d+)\s*([kmg]?)(?:i?b)?\s*$/i.exec(text ?? "");
  if (!m) return 2 * GIB;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  return unit === "g" ? n * GIB : unit === "m" ? n * MIB : unit === "k" ? n * 1024 : n;
}

export type Fit = "ok" | "tight" | "short" | "unknown";

/**
 * Whether a job that needs `needBytes` of memory fits on the server now: "short" when less than that is available, "tight"
 * when it fits but leaves under 15% of the server's memory (or 400 MB) for everything else, "unknown" without numbers.
 */
export function ramFit(stats: ServerStats, needBytes: number): Fit {
  if (!stats.online || stats.memAvailable === undefined || stats.memTotal === undefined) return "unknown";
  if (stats.memAvailable < needBytes) return "short";
  const margin = Math.max(0.15 * stats.memTotal, 400 * MIB);
  return stats.memAvailable - needBytes < margin ? "tight" : "ok";
}

/** One line: "4 CPUs · load 0.4 · 2.8 of 3.8 GB RAM free · 24 GB disk free". Missing numbers are left out. */
export function statsSummary(stats: ServerStats): string {
  if (!stats.online) return "not answering";
  const parts: string[] = [];
  if (stats.cpus !== undefined) parts.push(`${stats.cpus} ${stats.cpus === 1 ? "CPU" : "CPUs"}`);
  if (stats.load1 !== undefined) parts.push(`load ${stats.load1.toFixed(1)}`);
  if (stats.memAvailable !== undefined && stats.memTotal !== undefined) parts.push(`${formatBytes(stats.memAvailable)} of ${formatBytes(stats.memTotal)} RAM free`);
  if (stats.diskFree !== undefined) parts.push(`${formatBytes(stats.diskFree)} disk free`);
  return parts.join(" · ");
}
