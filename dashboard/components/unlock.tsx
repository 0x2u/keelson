"use client";

import { LockOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isStepUpError, UNLOCK_EVENT } from "@/lib/gate-core";

/** Opens the unlock dialog of the top bar, from anywhere. */
export function requestUnlock(): void {
  window.dispatchEvent(new Event(UNLOCK_EVENT));
}

/**
 * Reports a failed action outside the surface that is open. A step-up refusal carries an Unlock action that opens the same
 * dialog as the padlock in the top bar; anything else is a plain error.
 */
export function toastActionError(title: string, message?: string): void {
  if (isStepUpError(message)) {
    toast.error(title, { description: message, action: { label: "Unlock", onClick: requestUnlock } });
    return;
  }
  toast.error(title, message === undefined ? undefined : { description: message });
}

/** Next to an inline error: the Unlock button when the error is a step-up refusal, nothing otherwise. */
export function StepUpAction({ error }: { error: string | undefined | null }) {
  if (!isStepUpError(error)) return null;
  return (
    <Button type="button" variant="outline" size="sm" onClick={requestUnlock}>
      <LockOpenIcon />
      Unlock
    </Button>
  );
}
