import type { Deployment } from "@/lib/agent-types";

export interface DeploySummary {
  total: number;
  succeeded: number;
  /** failed, rolled_back and rollback_failed: the new version did not end up serving. */
  failed: number;
  running: number;
  /** Over the deployments that finished; null when none did. */
  medianSeconds: number | null;
}

type Summarised = Pick<Deployment, "status" | "started_at" | "finished_at">;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** What the deployments of an app add up to. A running one has no duration yet and is left out of the median, not counted as a failure. */
export function summarizeDeployments(deployments: readonly Summarised[]): DeploySummary {
  const durations: number[] = [];
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  for (const d of deployments) {
    if (d.status === "running") {
      running++;
      continue;
    }
    if (d.status === "succeeded") succeeded++;
    else failed++;
    if (d.finished_at) {
      const seconds = (Date.parse(d.finished_at) - Date.parse(d.started_at)) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0) durations.push(Math.round(seconds));
    }
  }
  return { total: deployments.length, succeeded, failed, running, medianSeconds: median(durations) };
}

/** "12 s", "1 min 5 s", "1 h 2 min". */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** The one-line summary above the deployment history; empty when there is nothing to summarise. */
export function deploySummaryLine(s: DeploySummary): string {
  if (s.total === 0) return "";
  const parts = [`${s.succeeded} succeeded`, `${s.failed} failed or rolled back`];
  if (s.running > 0) parts.push(`${s.running} running`);
  if (s.medianSeconds !== null) parts.push(`median duration ${formatSeconds(s.medianSeconds)}`);
  return `Last ${s.total} deployment${s.total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
