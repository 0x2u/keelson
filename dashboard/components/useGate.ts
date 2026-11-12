import { useMemo } from "react";
import { gateOf, type Gate } from "@/lib/gate-core";

/** The gate of one action: allowed, read-only (no deploy secret) or locked (needs step-up). */
export function useGate({ canDeploy, stepUp = false }: { canDeploy: boolean; stepUp?: boolean }): Gate {
  return useMemo(() => gateOf({ canDeploy, stepUp }), [canDeploy, stepUp]);
}
