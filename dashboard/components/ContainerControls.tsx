"use client";

import { PlayIcon, RotateCwIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { containerAction } from "@/app/container-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledWithReason, GatedButton } from "@/components/GatedButton";
import { toastActionError } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { containerControls } from "@/lib/container-core";

/**
 * Start for a stopped container, Restart (confirmed: it interrupts what it serves) for a running one. Only for containers
 * Keelson manages and on a server that can deploy; otherwise a disabled button says why.
 */
export function ContainerControls({
  serverId,
  name,
  state,
  managed,
  canDeploy,
  deploying = false,
  initialAction,
}: {
  serverId: string;
  name: string;
  state: { running: boolean; restarting?: boolean; paused?: boolean };
  managed: boolean;
  canDeploy: boolean;
  /** A deployment of the app is running: it is replacing the container. */
  deploying?: boolean;
  /** The `?restart=1` / `?start=1` of the page (the command palette's actions): Restart asks at once, Start takes the keyboard focus. Nothing happens until the operator confirms or presses it. */
  initialAction?: "start" | "restart";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const controls = containerControls(state, { managed, canDeploy, deploying });
  const [confirming, setConfirming] = useState(initialAction === "restart" && controls.restart);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Restart fails inside its dialog (inline); Start has no surface of its own, so its failure is a toast. */
  function run(action: "start" | "restart") {
    setError(null);
    startTransition(async () => {
      const result = await containerAction(serverId, name, action);
      if (result.error) {
        if (action === "restart") setError(result.error);
        else toastActionError(`Could not start ${name}`, result.error);
        return;
      }
      setConfirming(false);
      if (initialAction !== undefined) router.replace(pathname, { scroll: false });
      toast.success(action === "start" ? `${name} started` : `${name} restarted`);
      router.refresh();
    });
  }

  if (controls.reason !== undefined) {
    if (!managed) return null;
    const restartButton = (
      <Button variant="outline" disabled>
        <RotateCwIcon />
        Restart
      </Button>
    );
    return canDeploy ? (
      <DisabledWithReason reason={controls.reason}>{restartButton}</DisabledWithReason>
    ) : (
      <GatedButton canDeploy={false} variant="outline">
        <RotateCwIcon />
        Restart
      </GatedButton>
    );
  }

  return (
    <>
      {controls.start && (
        <Button variant="outline" onClick={() => run("start")} loading={pending} autoFocus={initialAction === "start"}>
          <PlayIcon />
          Start
        </Button>
      )}
      {controls.restart && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(next) => {
            if (next) setError(null);
            setConfirming(next);
            // The link of the palette's action is spent once the dialog closes: drop it so a reload does not ask again.
            if (!next && initialAction !== undefined) router.replace(pathname, { scroll: false });
          }}
          trigger={
            <Button variant="outline" disabled={pending}>
              <RotateCwIcon />
              Restart
            </Button>
          }
          title={`Restart ${name}?`}
          description="The container is restarted in place and is unavailable while it restarts. To replace the version behind a health check, deploy instead."
          confirmLabel="Restart"
          destructive
          pending={pending}
          error={error}
          onConfirm={() => run("restart")}
        />
      )}
    </>
  );
}
