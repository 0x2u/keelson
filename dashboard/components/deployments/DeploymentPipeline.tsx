"use client";

import { useEffect, useState } from "react";
import type { Deployment } from "@/lib/agent-types";
import { duration } from "@/lib/format";
import { pipeline, stepDuration, type PipelineStep } from "@/lib/pipeline-core";
import { cn } from "@/lib/utils";
import { StepGlyph, TONE_TEXT } from "@/components/deployments/step";

const BOX: Record<PipelineStep["state"], string> = {
  done: "border-transparent",
  running: "border-info/40 bg-info/5",
  failed: "border-destructive/50 bg-destructive/10",
  skipped: "border-transparent",
  pending: "border-transparent",
  notReached: "border-transparent",
  elsewhere: "border-transparent",
};

/** The ring of a step's node: filled when the step ran, hollow and dashed when it did not. */
const NODE: Record<PipelineStep["state"], string> = {
  done: "border-success/50 bg-success/10",
  running: "border-info/60 bg-info/10",
  failed: "border-destructive/60 bg-destructive/15",
  skipped: "border-border bg-muted/40",
  pending: "border-dashed border-border bg-transparent",
  notReached: "border-dashed border-border bg-transparent",
  elsewhere: "border-border bg-muted/40",
};

/** The line from a step to the next one: solid once the step is done, so the eye follows how far the deployment got. */
const LINK: Record<PipelineStep["state"], string> = {
  done: "bg-success/40",
  running: "bg-gradient-to-r from-info/50 to-border",
  failed: "bg-destructive/40",
  skipped: "bg-border",
  pending: "bg-border",
  notReached: "bg-border",
  elsewhere: "bg-border",
};

/** The clock of a running pipeline: null until the page is on screen (the server and the browser disagree on the time). */
function useNow(running: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/**
 * The pipeline of one deployment: Source, Build, Release, Switch, Soak, Live, each with what became of it and how long it
 * took, the failing step marked. A list in order (a row of steps on a wide screen, a column on a phone), each step
 * saying its state in words as well as in its colour and shape. Nothing when the agent does not report phases.
 */
export function DeploymentPipeline({ deployment }: { deployment: Pick<Deployment, "status" | "trigger" | "phases" | "started_at" | "finished_at"> }) {
  const p = pipeline(deployment);
  const now = useNow(deployment.status === "running");
  if (p === null) return null;
  const total = deployment.finished_at ? duration(deployment.started_at, deployment.finished_at) : now === null ? null : duration(deployment.started_at, undefined, now);
  return (
    <section aria-labelledby="pipeline-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="pipeline-title" className="text-base font-semibold tracking-tight">
          Pipeline
        </h2>
        {total !== null && (
          <p className="tabular text-sm text-muted-foreground">
            {deployment.finished_at ? "Took" : "Running for"} {total}
          </p>
        )}
      </div>
      <ol className="grid gap-1 lg:grid-flow-col lg:auto-cols-fr lg:gap-2" data-testid="pipeline">
        {p.steps.map((s, i) => {
          const took = stepDuration(s, now ?? undefined);
          return (
            <li key={s.name} aria-current={s.state === "running" ? "step" : undefined} data-step={s.name} data-state={s.state} className={cn("relative flex items-start gap-3 rounded-xl border px-3 py-3 lg:flex-col lg:gap-3", BOX[s.state])}>
              <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border", NODE[s.state], TONE_TEXT[s.view.tone])}>
                <StepGlyph state={s.state} />
              </span>
              {i < p.steps.length - 1 && (
                <>
                  <span aria-hidden className={cn("absolute top-[2.75rem] bottom-[-0.5rem] left-[1.75rem] w-px lg:hidden", LINK[s.state])} />
                  <span aria-hidden className={cn("absolute top-[1.75rem] right-[-0.75rem] left-[3.25rem] hidden h-px lg:block", LINK[s.state])} />
                </>
              )}
              <div className="min-w-0">
                <p className="font-display text-sm font-medium">{s.label}</p>
                <p className={cn("text-xs", TONE_TEXT[s.view.tone])}>
                  {s.view.label}
                  {took !== null && <span className="tabular text-muted-foreground"> · {took}</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
