"use client";

import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteAppAction, deleteDatabaseAction, deleteJobAction, saveNotificationsAction } from "@/app/config-actions";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";

export type DeletableEntity = { kind: "app" | "job" | "database"; name: string } | { kind: "notifications" };

function copy(entity: DeletableEntity): { trigger: string; title: string; effect: string; label: string; verb: "deleted" | "removed"; confirm: string } {
  switch (entity.kind) {
    case "app":
      return {
        trigger: "Delete app",
        title: `Delete ${entity.name}?`,
        effect: `This removes ${entity.name} from the configuration. The running container keeps running, but it is no longer managed by Keelson: it can no longer be deployed, rolled back or monitored from here.`,
        label: `app ${entity.name}`,
        verb: "deleted",
        confirm: "Delete app",
      };
    case "job":
      return {
        trigger: "Delete job",
        title: `Delete ${entity.name}?`,
        effect: `This removes ${entity.name} from the configuration. The job no longer runs on its schedule.`,
        label: `job ${entity.name}`,
        verb: "deleted",
        confirm: "Delete job",
      };
    case "database":
      return {
        trigger: "Delete database",
        title: `Delete ${entity.name}?`,
        effect: `This removes ${entity.name} from the configuration, so its scheduled backups stop and it can no longer be restored from here. The database itself and the backups already at the destination are not touched.`,
        label: `database ${entity.name}`,
        verb: "deleted",
        confirm: "Delete database",
      };
    case "notifications":
      return {
        trigger: "Remove notifications",
        title: "Remove notifications?",
        effect:
          "This removes the notifications section from the configuration. This server stops sending webhooks, Telegram messages and heartbeat pings, and the stored webhook URLs and heartbeat URL are deleted.",
        label: "notifications",
        verb: "removed",
        confirm: "Remove notifications",
      };
  }
}

/**
 * The button and confirmation for removing an app, a job, a database or the notifications section. All but the
 * notifications ask for the name to be typed; the dialog says exactly what changes. The agent may ask for a further acknowledgement, which the save
 * hook handles.
 */
export function DeleteEntityDialog({
  serverId,
  baseHash,
  entity,
  redirectTo,
}: {
  serverId: string;
  baseHash: string;
  entity: DeletableEntity;
  redirectTo: string;
}) {
  const router = useRouter();
  const save = useConfigSave();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = copy(entity);

  async function confirm() {
    setError(null);
    const { saved, result } = await save.run(
      text.label,
      ({ force }) => {
        const opts = { base_hash: baseHash, force };
        switch (entity.kind) {
          case "app":
            return deleteAppAction(serverId, entity.name, opts);
          case "job":
            return deleteJobAction(serverId, entity.name, opts);
          case "database":
            return deleteDatabaseAction(serverId, entity.name, opts);
          case "notifications":
            return saveNotificationsAction(serverId, null, opts);
        }
      },
      undefined,
      { inlineErrors: true, verb: text.verb },
    );
    if (saved) {
      setOpen(false);
      router.push(redirectTo);
    } else {
      setError(saveFailure(result));
    }
  }

  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        trigger={
          <Button type="button" variant="destructive">
            <ICONS.remove />
            {text.trigger}
          </Button>
        }
        title={text.title}
        description={text.effect}
        confirmLabel={text.confirm}
        destructive
        typeToConfirm={entity.kind === "notifications" ? undefined : entity.name}
        pending={save.pending}
        error={error}
        onConfirm={confirm}
      />
      {save.dialogs}
    </>
  );
}
