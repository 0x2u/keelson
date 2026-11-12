import { STEP_UP_MESSAGE, type StepUp } from "@/lib/step-up-core";

/**
 * A stand-in for lib/step-up.ts in action tests: with `state.locked` set, a verdict that requires the unlock is refused the way
 * the real one refuses it (the reason, then the step-up message the UI recognises); otherwise everything passes. `asked`
 * records what each action asked for, so a test can say that it did ask.
 *
 *   vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);
 */
export const state = { locked: false, asked: [] as { verdict: StepUp; what: string }[] };

export const fakeStepUp = {
  stepUpError: async (verdict: StepUp, what: string): Promise<string | null> => {
    state.asked.push({ verdict, what });
    return state.locked && verdict.required ? `${verdict.reason} ${STEP_UP_MESSAGE}` : null;
  },
};

export function resetStepUp(): void {
  state.locked = false;
  state.asked.length = 0;
}
