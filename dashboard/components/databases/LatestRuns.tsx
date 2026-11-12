import Link from "next/link";
import type { JobRun } from "@/lib/agent-types";
import { duration } from "@/lib/format";
import { triggerLabel } from "@/lib/labels-core";
import { parseRowCounts, runAnchor } from "@/lib/run-core";
import { JobBadge } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** The newest run of a kind, at the top of the page: status, when, how long, and for a restore the row counts. */
function LatestRun({ title, run }: { title: string; run: JobRun }) {
  const counts = parseRowCounts(run.output);
  return (
    <Card className="gap-3 py-4" data-testid={`latest-${title.toLowerCase()}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <JobBadge status={run.status} />
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <RelativeTime at={run.started_at} />
          <span className="tabular">{run.finished_at ? duration(run.started_at, run.finished_at) : "In progress"}</span>
          <span>{triggerLabel(run.trigger)}</span>
        </div>
        {run.detail && <p className="break-words text-destructive">{run.detail}</p>}
        {counts && (
          <div>
            <p className="text-muted-foreground">{counts.summary}</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
              {counts.tables.map((t) => (
                <li key={t.name}>
                  {t.name} <span className="tabular">{t.rows.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {run.output && (
          <Link href={`?run=${encodeURIComponent(run.id)}#${runAnchor(run.id)}`} className="inline-block text-xs font-medium underline-offset-4 hover:underline">
            Full output
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** What the last backup and the last restore did, before the tables of runs. Nothing when neither has run. */
export function LatestRuns({ backup, restore }: { backup?: JobRun; restore?: JobRun }) {
  if (!backup && !restore) return null;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {restore && <LatestRun title="Latest restore" run={restore} />}
      {backup && <LatestRun title="Latest backup" run={backup} />}
    </div>
  );
}
