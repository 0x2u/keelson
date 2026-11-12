"use client";

import { ArrowRightIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { useState, useTransition } from "react";
import { promoteAction, type PromoteInput } from "@/app/projects-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VersionChip } from "@/components/image-ref";
import { useOpenOutcome } from "@/components/outcome-toast";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import type { PromotionView } from "@/lib/projects-core";
import { deploymentToast } from "@/lib/toast-core";

function Version({ label }: { label: string | null }) {
  return label === null ? <span className="text-muted-foreground">nothing running</span> : <VersionChip tag={label} />;
}

/**
 * Promotes the version serving in one environment to another, after showing what the target runs now and what it will run.
 * Into production the confirmation is destructive-styled and names the app and both versions: that is the direction that
 * changes what users see. The other direction is neutral.
 */
export function PromoteButton({
  input,
  fromLabel,
  toLabel,
  toServer,
  toApp,
  view,
  blocked,
}: {
  input: PromoteInput;
  fromLabel: string;
  toLabel: string;
  toServer: string;
  /** The app that receives the version. */
  toApp: string;
  view: PromotionView;
  /** Why the promotion cannot be made, or null. */
  blocked: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const openOutcome = useOpenOutcome();
  const destructive = view.intoProduction;

  function promote() {
    setError(null);
    start(async () => {
      const r = await promoteAction(input);
      if (r.error) setError(r.error);
      else if (r.deploymentId) {
        setOpen(false);
        openOutcome(deploymentToast("promotion", { serverId: input.toServer, deploymentId: r.deploymentId, app: r.app ?? toApp, from: view.to ?? undefined, to: view.from ?? view.digest }));
      }
    });
  }

  if (blocked) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          {fromLabel} → {toLabel}
        </span>
        : {blocked}
      </p>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
      trigger={
        <Button variant={view.same ? "outline" : "default"}>
          <ICONS.deploy />
          Promote {fromLabel}
          <ArrowRightIcon />
          {toLabel}
        </Button>
      }
      title={destructive ? `Promote ${view.from ?? "this version"} to ${toLabel}?` : `Promote ${fromLabel} to ${toLabel}?`}
      description={
        <>
          Promotes the image that serves in {fromLabel} right now (<span className="font-mono">{view.digest}</span>) to {toApp} on {toServer}. It is the exact image, not a tag that could point elsewhere
          tomorrow. {toLabel} goes through its own release steps and health checks, and is rolled back if the new version does not start.
        </>
      }
      confirmLabel={`Promote to ${toLabel}`}
      destructive={destructive}
      pending={pending}
      error={error}
      onConfirm={promote}
    >
      <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm" aria-label="What will change">
        <p className="font-medium">
          {toApp} in {toLabel}
        </p>
        <span className="inline-flex flex-wrap items-center gap-2">
          <Version label={view.to} />
          <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <Version label={view.from} />
        </span>
        {view.same && <p className="text-muted-foreground">{toLabel} already runs this image: this deploys it again.</p>}
      </div>
      {destructive && !view.same && (
        <Notice tone="warning" title={`This changes what ${toLabel} serves`}>
          Users of {toApp} get {view.from ?? "this version"} as soon as it is healthy{view.to ? `, instead of ${view.to}` : ""}.
        </Notice>
      )}
    </ConfirmDialog>
  );
}
