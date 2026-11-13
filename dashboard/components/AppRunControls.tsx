"use client";

import { PlayIcon, SquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { startAppAction, stopAppAction } from "@/app/app-run-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledWithReason, GatedButton } from "@/components/GatedButton";
import { toastActionError } from "@/components/unlock";
import { Button } from "@/components/ui/button";
import { appRunControls } from "@/lib/app-run-core";

/**
 * Stop for a running app (confirmed: its domains answer 503 from then on) and Start for one that was stopped on purpose.
 * Stopping is `enabled: false` in the apps file, so it lasts across restarts of the server and of the agent; nothing but
 * Start brings the app back. A server that cannot deploy, or a deployment that is running, turns the button off with the reason.
 */
export function AppRunControls({
  serverId,
  app,
  stopped,
  hasContainer,
  canDeploy,
  deploying = false,
}: {
  serverId: string;
  app: string;
  /** `enabled: false`. */
  stopped: boolean;
  hasContainer: boolean;
  canDeploy: boolean;
  /** A deployment of the app is running: it is replacing the container. */
  deploying?: boolean;
}) {
  const router = useRouter();
  const controls = appRunControls({ stopped, hasContainer, canDeploy, deploying });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!controls.stop && !controls.start) return null;

  if (controls.reason !== undefined) {
    const label = controls.start ? "Start" : "Stop";
    const Icon = controls.start ? PlayIcon : SquareIcon;
    return canDeploy ? (
      <DisabledWithReason reason={controls.reason}>
        <Button variant="outline" disabled>
          <Icon />
          {label}
        </Button>
      </DisabledWithReason>
    ) : (
      <GatedButton canDeploy={false} variant="outline">
        <Icon />
        {label}
      </GatedButton>
    );
  }

  function stop() {
    setError(null);
    startTransition(async () => {
      const result = await stopAppAction(serverId, app);
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      toast.success(`${app} stopped`, { description: "Its domains answer 503 until you start it." });
      router.refresh();
    });
  }

  function start() {
    startTransition(async () => {
      const result = await startAppAction(serverId, app);
      // The app is enabled again even when its container did not start: say so, and refresh so the page shows that.
      if (result.error) {
        toastActionError(`Could not start ${app}`, result.error);
        router.refresh();
        return;
      }
      toast.success(`${app} started`);
      router.refresh();
    });
  }

  if (controls.start) {
    return (
      <Button variant="outline" onClick={start} loading={pending}>
        <PlayIcon />
        Start
      </Button>
    );
  }

  return (
    <ConfirmDialog
      open={confirming}
      onOpenChange={(next) => {
        if (next) setError(null);
        setConfirming(next);
      }}
      trigger={
        <Button variant="outline" disabled={pending}>
          <SquareIcon />
          Stop
        </Button>
      }
      title={`Stop ${app}?`}
      description={
        <>
          The container stops and stays stopped, and the domains of {app} answer 503 (&ldquo;This app is stopped.&rdquo;) until you start it again. Its configuration, image, variables, volumes, data and
          history are kept, and no alert is sent for it while it is stopped. Start brings it back.
        </>
      }
      confirmLabel="Stop"
      destructive
      pending={pending}
      error={error}
      onConfirm={stop}
    />
  );
}
