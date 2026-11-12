const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

/** "3 min ago", "2 h ago"... for a past instant. */
export function timeAgo(iso: string | number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** How long to wait before a relative time must be redrawn: seconds count up while an instant is under two minutes old. */
export function relativeTimeTick(iso: string | number, now: number = Date.now()): number {
  return Math.abs(now - new Date(iso).getTime()) < 120_000 ? 1_000 : 30_000;
}

/** Elapsed time between two instants, such as "12 s" or "3 min 5 s". */
export function duration(startIso: string, endIso: string | undefined, now: number = Date.now()): string {
  const end = endIso ? new Date(endIso).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * Shortens an image reference for display: drops the registry host and shows a
 * digest as its first 12 hex characters.
 */
export function shortRef(ref: string): string {
  const at = ref.indexOf("@sha256:");
  if (at >= 0) return `${ref.slice(0, at).split("/").slice(-1)[0]}@${ref.slice(at + 8, at + 20)}`;
  return ref.split("/").slice(-2).join("/");
}

/**
 * The list endpoint does not carry the health check result; Docker only puts it
 * in the human status text, such as "Up 3 minutes (healthy)" or "Up 5 seconds (health: starting)".
 */
export function healthFromStatus(status: string): "healthy" | "unhealthy" | "starting" | undefined {
  const match = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  if (!match) return undefined;
  return match[1] === "health: starting" ? "starting" : (match[1] as "healthy" | "unhealthy");
}

/**
 * "8080→80, 9443→9443" for the host ports a container publishes. Docker lists
 * a port once per address family (IPv4 and IPv6): show each mapping once.
 */
export function publishedPorts(ports: { public_port?: number; private_port: number }[]): string {
  const mappings = ports.filter((p) => p.public_port).map((p) => `${p.public_port}→${p.private_port}`);
  return [...new Set(mappings)].join(", ");
}

/** "in 5 min", "in 3 h", "in 2 d" for a future instant ("due now" when it has passed). */
export function timeUntil(iso: string | number, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds < 5) return "due now";
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.floor(hours / 24)} d`;
}
