import type { AppConfig, CanaryConfig } from "@/lib/agent-types";
import { parseDurationSeconds } from "@/lib/build-elsewhere-core";

/** The agent's limits on an app's canary rollout (agent/internal/config/canary.go). */
export const MAX_CANARY_STEPS = 5;
export const DEFAULT_CANARY_HOLD_SECONDS = 60;
export const MIN_CANARY_HOLD_SECONDS = 10;
export const MAX_CANARY_HOLD_SECONDS = 600;
export const DEFAULT_CANARY_HOLD = "1m";

/** The steps as the text field holds them: "10, 50". */
export function stepsDraft(app: Pick<AppConfig, "canary"> | undefined): string {
  return (app?.canary?.steps ?? []).join(", ");
}

/** The words of the steps field: separated by commas and/or spaces. */
function tokens(steps: string): string[] {
  return steps.split(/[\s,]+/).filter((t) => t !== "");
}

/** The `canary` block to send: absent when the steps are blank (a single switch). Validate with canaryErrors first. */
export function canaryFromDraft(steps: string, hold: string): CanaryConfig | undefined {
  const list = tokens(steps);
  if (list.length === 0) return undefined;
  const canary: CanaryConfig = { steps: list.map(Number) };
  const h = hold.trim();
  if (h !== "") canary.hold = h;
  return canary;
}

/** The number of seconds each step is held: the field as typed, blank being the agent's 1m; null when it is not a duration. */
export function holdSeconds(hold: string): number | null {
  return hold.trim() === "" ? DEFAULT_CANARY_HOLD_SECONDS : parseDurationSeconds(hold);
}

/** What is wrong with the canary, keyed `canary.steps` and `canary.hold`: the agent's own rules. */
export function canaryErrors(steps: string, hold: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const list = tokens(steps);
  if (list.length === 0) return errors; // no steps: the hold means nothing and nothing is sent
  if (list.length > MAX_CANARY_STEPS) errors["canary.steps"] = `canary lists ${list.length} steps: between 1 and ${MAX_CANARY_STEPS}, such as steps: [10, 50]`;
  else {
    let previous = 0;
    for (const [i, t] of list.entries()) {
      const n = Number(t);
      if (!/^\d+$/.test(t) || n < 1 || n > 99) {
        errors["canary.steps"] = `canary.steps[${i}] is ${t}: a step is a percentage from 1 to 99 (100 is the end of the rollout, it needs no step)`;
        break;
      }
      if (n <= previous) {
        errors["canary.steps"] = "the steps must rise";
        break;
      }
      previous = n;
    }
  }
  const seconds = holdSeconds(hold);
  if (seconds === null) errors["canary.hold"] = "A number and a unit, for example 1m.";
  else if (seconds < MIN_CANARY_HOLD_SECONDS || seconds > MAX_CANARY_HOLD_SECONDS) errors["canary.hold"] = "canary.hold must be between 10s and 10m";
  return errors;
}
