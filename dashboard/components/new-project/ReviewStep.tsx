"use client";

import type { ReactNode } from "react";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import type { ProjectVar } from "@/lib/new-project-core";
import { STEP_LABEL } from "@/components/new-project/Progress";
import { DATABASE_ENV_KEY, STEP_ORDER } from "@/lib/new-project-core";
import { optionLines, variableLines, type ReviewLine } from "@/lib/new-project-wizard-core";
import { getPreset } from "@/lib/presets-core";
import type { Review } from "@/lib/repo-detect-core";

/**
 * The summary of everything that will be written, before the button: names, never a value. The variables are listed by
 * name with their build-time flag; their values are not part of this component's props at all, only the list of names.
 */
export function ReviewStep({
  repo,
  serverName,
  review,
  variables,
  envSupported,
  database,
  dns,
  errorCount,
}: {
  repo: string;
  serverName: string;
  /** The form as it will be sent; null while it still has problems. */
  review: Review | null;
  /** Names and flags only. */
  variables: Pick<ProjectVar, "key" | "build">[];
  envSupported: boolean;
  /** A PostgreSQL database for the app is asked for. */
  database: boolean;
  /** What happens to the domain's DNS, in words; null without a domain. */
  dns: string | null;
  errorCount: number;
}) {
  if (review === null) {
    return (
      <Notice title="The form is not complete">
        {errorCount} field{errorCount === 1 ? "" : "s"} need attention. Go back to the step that has them: nothing is lost.
      </Notice>
    );
  }
  const preset = getPreset(review.preset);
  const lines: ReviewLine[] = [
    { label: "Repository", value: `${repo}, branch ${review.branch}` },
    { label: "Server", value: serverName },
    { label: "App and image", value: `${review.name} (keelson-local/${review.name})` },
    { label: "Framework", value: preset.label },
    ...(review.preset === "dockerfile"
      ? [
          { label: "Dockerfile", value: review.dockerfile },
          { label: "Build context", value: review.context },
        ]
      : optionLines(review.preset, review.options)),
    { label: "Container port", value: String(review.port) },
    { label: "Exposed as", value: review.exposure.kind === "domain" ? `https://${review.exposure.domain}` : `127.0.0.1:${review.exposure.hostPort} on the server` },
    ...(review.healthPath !== "" ? [{ label: "Health path", value: review.healthPath }] : []),
    { label: "Run before each deploy", value: review.release === "" ? "nothing" : review.release },
    ...(review.envFile !== "" ? [{ label: "Environment file", value: review.envFile }] : []),
    { label: "Build limits", value: `${review.memory} memory, ${review.cpus} CPUs, ${review.timeout} timeout` },
    ...(review.buildHostNetwork ? [{ label: "Build network", value: "the server's own network (it can reach a database on 127.0.0.1)" }] : []),
    { label: "Each push", value: review.buildOnPush ? "built and deployed" : "not built" },
    ...(database ? [{ label: "Database", value: `a new PostgreSQL database for ${review.name}, its URL in ${DATABASE_ENV_KEY}${review.buildDatabase ? ", also given to the build" : ", read when the app starts only"}` }] : []),
    { label: "Pull requests", value: review.previews ? "a preview of each" : "no previews" },
  ];
  return (
    <ReviewPanel
      lines={lines}
      variables={variables}
      envSupported={envSupported}
      plan={STEP_ORDER.map((step) => ({
        label: STEP_LABEL[step],
        note:
          step === "database" ? (
            database ? (
              <span className="block text-muted-foreground">Backed up every day; the backup key is shown once, after creation.</span>
            ) : (
              " (none asked for)"
            )
          ) : step === "env" ? (
            variables.length === 0 || !envSupported ? " (nothing to set)" : ` (${variables.length})`
          ) : step === "dns" ? (
            dns === null ? (
              " (no domain)"
            ) : (
              <span className="block text-muted-foreground">{dns}</span>
            )
          ) : step === "link" ? (
            <span className="block text-muted-foreground">
              {repo}, branch {review.branch}
            </span>
          ) : step === "build" ? (
            <span className="block text-muted-foreground">Then you are taken to the deployment.</span>
          ) : null,
      }))}
    />
  );
}

/** What a review shows, whatever the door: the lines that will be written, the variables by name, and the steps in order. */
export function ReviewPanel({
  lines,
  variables,
  envSupported,
  plan,
}: {
  lines: ReviewLine[];
  /** Names and flags only. */
  variables: Pick<ProjectVar, "key" | "build">[];
  envSupported: boolean;
  /** The steps that run, in order, each with what to add after its name. */
  plan: { label: string; note: ReactNode }[];
}) {
  const vars = variableLines(variables as ProjectVar[]);
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Nothing is written before you press the button below. This is everything it will do, in this order.</p>
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]" data-testid="review-config">
        {lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="min-w-0 break-words font-mono text-xs sm:text-sm">{l.value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2 rounded-lg border p-4" data-testid="review-variables">
        <p className="text-sm font-medium">Variables ({variables.length})</p>
        {!envSupported ? (
          <p className="text-sm text-muted-foreground">This agent is too old to manage variables: none are set.</p>
        ) : vars.length === 0 ? (
          <p className="text-sm text-muted-foreground">None. They can be added from the app&apos;s Variables page.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {vars.map((v) => (
              <li key={v.label} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs break-all">{v.label}</span>
                <Badge variant={v.value === "runtime only" ? "muted" : "warning"}>{v.value}</Badge>
              </li>
            ))}
          </ul>
        )}
        {vars.length > 0 && <p className="text-xs text-muted-foreground">Values are not shown: they go to the agent when you create the project.</p>}
      </div>

      <ol className="space-y-2 rounded-lg border p-4 text-sm" data-testid="review-steps">
        {plan.map((step, i) => (
          <li key={step.label} className="flex gap-2">
            <span className="w-5 shrink-0 text-muted-foreground">{i + 1}.</span>
            <span className="min-w-0">
              {step.label}
              {step.note}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
