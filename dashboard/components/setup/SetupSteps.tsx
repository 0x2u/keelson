import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = ["Password", "Recovery file", "Second factor"] as const;

/** Where the operator is in the first-run setup: three steps, the finished ones checked, the current one marked for assistive technology. */
export function SetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center justify-between gap-2 text-xs" aria-label="Setup steps">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        return (
          <li key={label} aria-current={step === current ? "step" : undefined} className={cn("flex items-center gap-2", step === current ? "font-medium text-foreground" : "text-muted-foreground")}>
            <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums",
                step === current && "border-primary bg-primary text-primary-foreground",
                done && "border-success-text/40 text-success-text",
              )}
            >
              {done ? <CheckIcon className="size-3" /> : step}
            </span>
            <span>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
