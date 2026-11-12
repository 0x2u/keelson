import { ramFit, statsSummary, type Fit, type ServerStats } from "@/lib/server-stats-core";
import { cn } from "@/lib/utils";

const BAR: Record<Fit, string> = { ok: "bg-success", tight: "bg-warning", short: "bg-destructive", unknown: "bg-muted-foreground/40" };

/**
 * A server's numbers on one line, with a small bar of the memory in use: what tells two servers apart at a glance. The bar
 * is red when `needBytes` (what a job would take) does not fit in the free memory, amber when it fits with little to spare.
 */
export function ServerStatsLine({ stats, needBytes, className }: { stats: ServerStats; needBytes?: number; className?: string }) {
  const used = stats.memTotal && stats.memAvailable !== undefined ? Math.min(100, Math.max(0, Math.round((1 - stats.memAvailable / stats.memTotal) * 100))) : null;
  // Without a job to size, the bar says how full the memory is: amber from 75%, red from 90%.
  const fit: Fit = needBytes !== undefined ? ramFit(stats, needBytes) : !stats.online || used === null ? "unknown" : used >= 90 ? "short" : used >= 75 ? "tight" : "ok";
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)} data-testid="server-stats">
      {used !== null && (
        <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted" title={`${used}% of the memory is in use`}>
          <span className={cn("block h-full rounded-full", BAR[fit])} style={{ width: `${used}%` }} />
        </span>
      )}
      <span>{statsSummary(stats)}</span>
    </span>
  );
}
