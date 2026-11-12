import { serverStatus, type Tone } from "@/lib/status";

/** One server as /api/fleet/health reports it: the attention model's verdict for it. */
export interface ServerDotStatus {
  id: string;
  reachable: boolean;
  tone: Tone;
  label: string;
  count: number;
}

export interface ServerDot {
  tone: Tone;
  /** For the tooltip and screen readers: the colour is never the only carrier. */
  label: string;
}

/** The sidebar's dot for a server: grey while unknown, then the same status every other place shows (Online, the attention verdict, Unreachable). */
export function serverDot(status: ServerDotStatus | undefined): ServerDot {
  if (!status) return { tone: "muted", label: "Status unknown" };
  const { tone, label } = serverStatus({ reachable: status.reachable, attention: status });
  return { tone, label };
}
