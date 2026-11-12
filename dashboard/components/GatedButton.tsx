"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGate } from "@/components/useGate";
import { READ_ONLY_REASON } from "@/lib/gate-core";

/**
 * A control that cannot be used: the reason sits in a tooltip that keyboard focus reaches (the wrapper is focusable, the
 * button inside is disabled and so is not).
 */
export function DisabledWithReason({ reason, children, className }: { reason: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={className ?? "inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The one button for actions that change a server: read-only server = disabled with the reason "Read-only server" in a
 * focusable tooltip; locked (needs step-up) = enabled, the failed action offers Unlock (see `toastActionError`).
 */
export function GatedButton({
  canDeploy,
  stepUp = false,
  ...props
}: ComponentProps<typeof Button> & { canDeploy: boolean; stepUp?: boolean }) {
  const gate = useGate({ canDeploy, stepUp });
  if (gate.state === "read-only") {
    return (
      <DisabledWithReason reason={READ_ONLY_REASON}>
        <Button {...props} disabled aria-disabled data-gate="read-only" />
      </DisabledWithReason>
    );
  }
  return <Button {...props} data-gate={gate.state} />;
}
