import type { ReactNode } from "react";
import { JobBadge } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";

/** What a job or a backup schedule has to say about its next run; one wording everywhere. `null`: nothing is configured at all. */
export function nextRunText(schedule: { running?: boolean; paused?: boolean; next_run?: string | null } | null | undefined): ReactNode {
  if (!schedule) return "–";
  if (schedule.running) return "Running now";
  if (schedule.paused) return "Paused";
  return schedule.next_run ? <RelativeTime at={schedule.next_run} future /> : "Nothing scheduled";
}

/** Its last run: the outcome and when, or "Never run". */
export function lastRunText(run: { status: string; started_at: string } | null | undefined, className?: string): ReactNode {
  if (!run) return <span className="text-muted-foreground">Never run</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <JobBadge status={run.status} />
      <RelativeTime at={run.started_at} className={className ?? "text-muted-foreground"} />
    </span>
  );
}
