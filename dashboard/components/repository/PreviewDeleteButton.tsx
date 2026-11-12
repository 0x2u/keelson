"use client";

import { ICONS } from "@/lib/icons";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deletePreviewAction } from "@/app/github-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toastCopy } from "@/lib/toast-core";

/** Removes one preview now: its containers, route and images. */
export function PreviewDeleteButton({ serverId, app, pr, name }: { serverId: string; app: string; pr: number; name: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setError(null);
    startTransition(async () => {
      const out = await deletePreviewAction(serverId, app, pr);
      if (out.error) {
        setError(out.error);
        return;
      }
      setOpen(false);
      toast.success(toastCopy.deleted(name));
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
      trigger={
        <Button variant="ghost" size="icon" aria-label={`Delete ${name}`}>
          <ICONS.remove />
        </Button>
      }
      title={`Delete ${name}`}
      description="The preview's containers, its route and its images are removed now. It is created again the next time the pull request's workflow succeeds."
      confirmLabel="Delete preview"
      destructive
      typeToConfirm={name}
      pending={pending}
      error={error}
      onConfirm={remove}
    />
  );
}
