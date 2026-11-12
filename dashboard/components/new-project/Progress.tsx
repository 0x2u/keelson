"use client";

import { CheckCircle2Icon, CircleAlertIcon, CircleDashedIcon, CircleMinusIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { IssuesList } from "@/components/config/IssuesList";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { StepUpAction } from "@/components/unlock";
import { isStepUpError } from "@/lib/gate-core";
import { STEP_ORDER, type ProjectOutcome, type RetryStep, type StepName } from "@/lib/new-project-core";

export const STEP_LABEL: Record<StepName, string> = {
  config: "Write the app into the server's configuration",
  database: "Create the app's PostgreSQL database",
  env: "Set the variables on the server",
  link: "Link the app to the repository",
  dns: "Point the domain at the server",
  build: "Start the first build",
};

/** What a project from an image runs: no database, no repository link, and the build is the first deployment. */
const IMAGE_STEPS: readonly StepName[] = ["config", "env", "dns", "build"];
const IMAGE_LABEL: Partial<Record<StepName, string>> = { build: "Start the first deployment" };

export type Door = "repository" | "image";

function labelOf(door: Door, step: StepName): string {
  return (door === "image" ? IMAGE_LABEL[step] : undefined) ?? STEP_LABEL[step];
}

function StepIcon({ state }: { state: "done" | "failed" | "todo" | "skipped" }) {
  if (state === "skipped") return <CircleMinusIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  if (state === "done") return <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />;
  if (state === "failed") return <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />;
  return <CircleDashedIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

interface ProgressProps {
  outcome: ProjectOutcome;
  onRetry: (step: RetryStep) => void;
  pending: boolean;
  dnsDecision?: ReactNode;
  retryBlocked?: boolean;
  /** Which door the project came through: an image has fewer steps. Default: a repository. */
  door?: Door;
}

/** What is done and what is not, after a step failed: nothing is rolled back, and the failed step can be retried. */
function Progress({ outcome, onRetry, pending, dnsDecision, retryBlocked, door = "repository" }: ProgressProps) {
  const steps = door === "image" ? IMAGE_STEPS : STEP_ORDER;
  const failed = steps.find((s) => outcome.steps[s].state === "failed");
  const written = outcome.steps.config.state === "done";
  return (
    <Notice title={written ? "The project was created, but not everything is done" : "Nothing was created"}>
      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step} className="flex items-start gap-2 text-sm">
            <StepIcon state={outcome.steps[step].state} />
            <div className="min-w-0">
              <p className="font-medium">{labelOf(door, step)}</p>
              <p className="break-words text-muted-foreground">{outcome.steps[step].detail}</p>
              {outcome.steps[step].state === "failed" && isStepUpError(outcome.steps[step].detail) && <StepUpAction error={outcome.steps[step].detail} />}
              {step === "env" && outcome.varIssues && outcome.varIssues.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                  {outcome.varIssues.map((i, n) => (
                    <li key={n}>
                      {i.key !== "" && <span className="font-mono">{i.key}</span>} {i.message}
                    </li>
                  ))}
                </ul>
              )}
              {step === "dns" && outcome.steps.dns.state === "failed" && dnsDecision}
            </div>
          </li>
        ))}
      </ol>
      {outcome.issues.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-sm font-medium">What the agent said</p>
          <IssuesList issues={outcome.issues} />
        </div>
      )}
      {written && failed !== undefined && failed !== "config" && (
        <p className="mt-3 text-sm">The app stays in the agent&apos;s configuration; it was not rolled back. Retry the failed step, or fix it from the app&apos;s pages.</p>
      )}
      {outcome.retry && (
        <Button type="button" variant="outline" size="sm" className="mt-3 w-fit" loading={pending} disabled={retryBlocked === true} onClick={() => onRetry(outcome.retry!)}>
          Retry: {labelOf(door, outcome.retry).toLowerCase()}
        </Button>
      )}
    </Notice>
  );
}

/**
 * The outcome of an attempt, above the form while the buttons are in a bar at the bottom: it takes the focus when it
 * appears (which scrolls it into view), or the operator would not see that the attempt failed or what is left to do.
 */
export function ProgressPanel(props: ProgressProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [props.outcome]);
  return (
    <div ref={ref} tabIndex={-1} className="scroll-mt-20 outline-none">
      <Progress {...props} />
    </div>
  );
}
