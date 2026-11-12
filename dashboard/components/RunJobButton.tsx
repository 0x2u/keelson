"use client";

import { PlayIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runJobAction } from "@/app/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { GatedButton } from "@/components/GatedButton";
import { showOutcomeToast } from "@/components/outcome-toast";
import { toastActionError } from "@/components/unlock";
import { jobRunToast } from "@/lib/toast-core";

/**
 * Runs a job now. The run is recorded like a scheduled one, with trigger "manual". The toast stays until dismissed and
 * links to the run's output; `database` makes it the database's page (a backup shows there). A server without the deploy
 * secret (`canDeploy` false) shows the button disabled as "Read-only server".
 */
export function RunJobButton({
  serverId,
  job,
  disabled,
  label = "Run now",
  database,
  canDeploy = true,
  confirmOnOpen = false,
  size = "sm",
}: {
  serverId: string;
  job: string;
  disabled?: boolean;
  label?: string;
  database?: string;
  canDeploy?: boolean;
  /** The page's `?runnow=1` (the command palette's "Run job"): asks first, in a dialog. Nothing runs until it is confirmed. */
  confirmOnOpen?: boolean;
  /** `xs` in table rows, next to the Edit link. */
  size?: "sm" | "xs";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(confirmOnOpen && canDeploy && !disabled);
  const [error, setError] = useState<string | null>(null);

  function closeConfirm(open: boolean) {
    if (pending) return;
    if (open) setError(null);
    setConfirming(open);
    // The link is spent once the dialog closes: drop it so a reload does not ask again.
    if (!open && confirmOnOpen) router.replace(pathname, { scroll: false });
  }

  /** From the dialog the failure is shown inside it; the button has no surface of its own, so its failure is a toast. */
  function run() {
    setError(null);
    start(async () => {
      const result = await runJobAction(serverId, job);
      if (result.error) {
        if (confirming) setError(result.error);
        else toastActionError(`Could not start ${job}`, result.error);
        return;
      }
      setConfirming(false);
      if (confirmOnOpen) router.replace(pathname, { scroll: false });
      showOutcomeToast(jobRunToast({ serverId, job, runId: result.runId, label: label.replace(/ now$/i, ""), database }), (href) => router.push(href));
      // The run is asynchronous: refresh now to show "running", then again once it has had time to finish.
      router.refresh();
      setTimeout(() => router.refresh(), 3000);
    });
  }

  return (
    <>
      <GatedButton canDeploy={canDeploy} type="button" variant="outline" size={size} onClick={run} loading={pending} disabled={disabled} aria-label={label === "Run now" ? `Run now: ${job}` : undefined}>
        <PlayIcon />
        {label}
      </GatedButton>
      {confirmOnOpen && canDeploy && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={closeConfirm}
          title={`Run ${job} now?`}
          description="It runs once, immediately, outside its schedule, and is recorded as a manual run. What it does is what it does on schedule: it can change data."
          confirmLabel="Run now"
          pending={pending}
          error={error}
          onConfirm={run}
        />
      )}
    </>
  );
}
