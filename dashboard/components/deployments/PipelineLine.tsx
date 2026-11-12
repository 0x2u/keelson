import { pipeline, type PipelineSource } from "@/lib/pipeline-core";
import { cn } from "@/lib/utils";
import { StepGlyph, TONE_TEXT } from "@/components/deployments/step";

/**
 * The pipeline of a deployment in one line, for a card or a row: "Release ✓ Switch ● Soak ○". Each step says its state
 * in words for a screen reader. Nothing when the agent does not report phases.
 */
export function PipelineLine({ deployment, className }: { deployment: PipelineSource; className?: string }) {
  const p = pipeline(deployment);
  if (p === null) return null;
  return (
    <ol aria-label="Pipeline" className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs", className)} data-testid="pipeline-line">
      {p.steps.map((s) => (
        <li key={s.name} data-state={s.state} className={cn("inline-flex items-center gap-1", TONE_TEXT[s.view.tone], s.state === "failed" && "font-medium")}>
          {s.label}
          <StepGlyph state={s.state} className="size-3" />
          <span className="sr-only">{s.view.label}</span>
        </li>
      ))}
    </ol>
  );
}
