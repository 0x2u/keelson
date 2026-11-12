import { STEP_UP_MESSAGE } from "@/lib/step-up-core";

/**
 * One gating pattern for every button that changes something.
 * - allowed: works.
 * - read-only: the server has no deploy secret in the dashboard; the control is disabled and says why.
 * - locked: the action needs step-up and the session has not unlocked changes; the control stays enabled, and when the
 *   server refuses with the step-up message, the operator is offered an Unlock action that opens the top bar's dialog.
 */
export type GateState = "allowed" | "read-only" | "locked";

export interface Gate {
  state: GateState;
  /** Why the control is not simply allowed; null when it is. */
  reason: string | null;
}

export const READ_ONLY_REASON = "Read-only server";
export const LOCKED_REASON = "Needs unlocking: your password and an authenticator code";

/** The gate of an action; `stepUp` is true when it needs an unlocked session and the session is not unlocked. */
export function gateOf({ canDeploy, stepUp = false }: { canDeploy: boolean; stepUp?: boolean }): Gate {
  if (!canDeploy) return { state: "read-only", reason: READ_ONLY_REASON };
  if (stepUp) return { state: "locked", reason: LOCKED_REASON };
  return { state: "allowed", reason: null };
}

/** Whether an action's error message is the server asking for step-up. */
export function isStepUpError(message: string | undefined | null): boolean {
  return typeof message === "string" && message.includes(STEP_UP_MESSAGE);
}

/** The event the top bar listens for to open the unlock dialog. */
export const UNLOCK_EVENT = "keelson:unlock";
