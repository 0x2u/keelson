import { ChevronRightIcon } from "lucide-react";
import { duration } from "@/lib/format";
import type { JobRun } from "@/lib/agent-types";
import { triggerLabel } from "@/lib/labels-core";
import { runAnchor } from "@/lib/run-core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { JobBadge } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";
import { CopyButton } from "@/components/copy-button";

/**
 * Runs of a job, newest first, each with its output on demand and an anchor (#run-<id>) a toast can link to.
 * `openFirst` shows the newest run's output at once; `highlight` (the id from ?run=) marks one run and opens its output.
 */
export function JobRunList({ runs, openFirst = false, highlight }: { runs: JobRun[]; openFirst?: boolean; highlight?: string }) {
  return (
    <ul className="divide-y">
      {runs.map((r, index) => {
        const marked = r.id === highlight;
        return (
          <li key={r.id} id={runAnchor(r.id)} data-highlighted={marked || undefined} className={cn("scroll-mt-24 target:bg-muted/40", marked && "bg-muted/40 ring-1 ring-inset ring-ring")}>
            <Collapsible key={r.output ? "output" : "none"} defaultOpen={(marked || (openFirst && index === 0 && highlight === undefined)) && Boolean(r.output)}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <JobBadge status={r.status} />
                <RelativeTime at={r.started_at} />
                <span className="tabular text-muted-foreground">{r.finished_at ? duration(r.started_at, r.finished_at) : "In progress"}</span>
                <Badge variant="outline">{triggerLabel(r.trigger)}</Badge>
                {r.detail && <span className="min-w-0 break-words text-destructive-text">{r.detail}</span>}
                {r.output && (
                  <CollapsibleTrigger className="group ml-auto flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                    Output
                  </CollapsibleTrigger>
                )}
              </div>
              {r.output && (
                <CollapsibleContent>
                  <div className="relative mx-4 mb-3">
                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 pr-10 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
                      {r.output}
                    </pre>
                    <div className="absolute right-1 top-1">
                      <CopyButton value={r.output} label="Copy output" />
                    </div>
                  </div>
                </CollapsibleContent>
              )}
            </Collapsible>
          </li>
        );
      })}
    </ul>
  );
}
