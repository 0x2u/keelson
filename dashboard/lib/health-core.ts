import type { Container, SystemInfo } from "@/lib/agent-types";
import { healthFromStatus } from "@/lib/format";
import type { Tone } from "@/lib/status";

/** Used share of a limited resource (memory, disk): from 85% worth a look, from 95% urgent. */
export function usageTone(used: number, total: number): Tone {
  if (total <= 0) return "muted";
  const f = used / total;
  return f >= 0.95 ? "danger" : f >= 0.85 ? "warning" : "success";
}

/** The 1-minute load relative to the CPU count: above 1 per CPU work is queueing, above 2 it is badly behind. */
export function loadTone(one: number, cpus: number): Tone {
  if (cpus <= 0) return "muted";
  const perCpu = one / cpus;
  return perCpu >= 2 ? "danger" : perCpu >= 1 ? "warning" : "success";
}

/** "12 d 3 h", "3 h 5 min", "42 min": the two largest units. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export interface Assessment {
  tone: Tone;
  /** What is wrong, worst first. Empty when everything is fine. */
  reasons: string[];
}

const RANK: Record<Tone, number> = { danger: 3, warning: 2, info: 1, muted: 0, success: 0 };

export type SignalKind = "engine" | "disk" | "memory" | "load" | "containers";

export interface Signal {
  kind: SignalKind;
  tone: Tone;
  text: string;
}

/** Containers that exist to run and exit (a release step, a job's one-off container) are not "stopped". */
const ONE_SHOT_LABELS = ["keelson.job", "keelson.release"];

/** A container keelson manages for an app that should be serving but is not: exited, dead or being restarted. */
export function isDownManaged(c: Container): boolean {
  if (!c.labels?.["keelson.app"] || ONE_SHOT_LABELS.some((l) => c.labels[l])) return false;
  return c.state === "exited" || c.state === "dead" || c.state === "restarting";
}

/** A running container whose health check fails, or one that keeps restarting. */
export function isSick(c: Container): boolean {
  return c.state === "restarting" || (c.state === "running" && healthFromStatus(c.status) === "unhealthy");
}

/**
 * Every signal the machine itself gives, worst first. A signal that could not be read is not a problem on its own; the
 * screen says it is unknown.
 */
export function signals(system: SystemInfo, containers: Container[] | undefined): Signal[] {
  const found: Signal[] = [];
  const { host } = system;

  if (system.engine_error) found.push({ kind: "engine", tone: "danger", text: "Docker does not answer" });
  if (host.disk) {
    const used = host.disk.total - host.disk.free;
    const tone = usageTone(used, host.disk.total);
    if (tone !== "success" && tone !== "muted") {
      found.push({ kind: "disk", tone, text: `Disk ${Math.round((used / host.disk.total) * 100)}% full` });
    }
  }
  if (host.memory) {
    const used = host.memory.total - host.memory.available;
    const tone = usageTone(used, host.memory.total);
    if (tone !== "success" && tone !== "muted") {
      found.push({ kind: "memory", tone, text: `Memory ${Math.round((used / host.memory.total) * 100)}% used` });
    }
  }
  if (host.load) {
    const tone = loadTone(host.load.one, host.cpus);
    if (tone !== "success" && tone !== "muted") {
      found.push({ kind: "load", tone, text: `Load ${host.load.one.toFixed(2)} on ${host.cpus} CPU${host.cpus === 1 ? "" : "s"}` });
    }
  }
  if (containers) {
    const sick = containers.filter(isSick);
    if (sick.length > 0) found.push({ kind: "containers", tone: "danger", text: `${sick.length} container${sick.length === 1 ? "" : "s"} unhealthy or restarting` });
    const stopped = containers.filter((c) => isDownManaged(c) && !isSick(c));
    if (stopped.length > 0) found.push({ kind: "containers", tone: "danger", text: `${stopped.length} app container${stopped.length === 1 ? "" : "s"} stopped` });
  }
  return found.sort((a, b) => RANK[b.tone] - RANK[a.tone]);
}

/** The machine's own verdict: the worst of its signals. The server's full verdict is the attention model's (lib/attention-core.ts). */
export function assess(system: SystemInfo, containers: Container[] | undefined): Assessment {
  const found = signals(system, containers);
  return { tone: found.length === 0 ? "success" : found[0].tone, reasons: found.map((f) => f.text) };
}
