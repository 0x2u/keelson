import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Where the operator is: the steps in order, the ones already reached can be gone back to. */
export function Stepper<T extends string>({ steps, step, furthest, onGo }: { steps: readonly { id: T; label: string }[]; step: T; furthest: number; onGo: (id: T) => void }) {
  const at = steps.findIndex((s) => s.id === step);
  return (
    <nav aria-label="Progress" className="space-y-2">
      <ol className="flex items-center gap-1 sm:gap-2">
        {steps.map((s, i) => {
          const reachable = i <= furthest;
          const state = i < at ? "done" : i === at ? "current" : "todo";
          return (
            <li key={s.id} className="flex min-w-0 items-center gap-1 sm:gap-2 sm:last:flex-none max-sm:flex-1">
              <button
                type="button"
                disabled={!reachable}
                aria-current={state === "current" ? "step" : undefined}
                onClick={() => onGo(s.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                  state === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
                  reachable && state !== "current" && "hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                    state === "done" && "border-primary bg-primary text-primary-foreground",
                    state === "current" && "border-primary text-foreground",
                  )}
                >
                  {state === "done" ? <CheckIcon aria-hidden className="size-3.5" /> : i + 1}
                </span>
                <span className={cn(state !== "current" ? "max-lg:hidden" : "max-sm:hidden")}>{s.label}</span>
              </button>
              {i < steps.length - 1 && <span aria-hidden className="h-px min-w-2 flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground sm:hidden">
        Step {at + 1} of {steps.length}: {steps[at].label}
      </p>
    </nav>
  );
}
