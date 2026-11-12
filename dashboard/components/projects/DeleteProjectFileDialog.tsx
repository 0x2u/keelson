"use client";

import { ICONS } from "@/lib/icons";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteProjectConfigAction } from "@/app/project-config-actions";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import type { SaveNotice } from "@/lib/app-config-core";
import type { SplitMove } from "@/lib/project-config-core";

/**
 * Removes the project's own file from one server. What it holds leaves the configuration, so the dialog lists it, asks
 * for the project's name to be typed, and the agent then asks to acknowledge the apps and jobs that go (the save hook
 * shows that). When apps leave, the project may no longer exist on any server: the page then goes to the projects list.
 */
export function DeleteProjectFileDialog({
  serverId,
  serverName,
  project,
  file,
  hash,
  holds,
  appsLeave,
}: {
  serverId: string;
  serverName: string;
  project: string;
  /** "projects.d/<project>.yaml". */
  file: string;
  /** The file's hash: the base of the removal. */
  hash: string;
  /** What the file holds, by kind. */
  holds: SplitMove[];
  appsLeave: boolean;
}) {
  const router = useRouter();
  const save = useConfigSave();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notice: SaveNotice = {
    title: `${file} removed`,
    description: appsLeave ? `The apps of ${project} left the configuration of ${serverName}.` : `${project} has no file on ${serverName} any more.`,
    persistent: false,
  };

  async function confirm() {
    setError(null);
    const { saved, result } = await save.run(
      file,
      ({ force }) => deleteProjectConfigAction(serverId, project, { base_hash: hash, force }),
      notice,
      { inlineErrors: true, verb: "deleted" },
    );
    if (saved) {
      setOpen(false);
      if (appsLeave) router.push("/projects");
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
            Delete {file}
          </Button>
        }
        title={`Delete the file of ${project} on ${serverName}?`}
        description={
          holds.length === 0
            ? `${file} holds no app, job or database; removing it only takes the file away.`
            : `${file} is removed with everything in it: these leave the configuration of ${serverName}. The agent lists the apps and jobs that go and asks you to confirm before anything is changed.`
        }
        confirmLabel="Delete the file"
        destructive
        typeToConfirm={project}
        pending={save.pending}
        error={error}
        onConfirm={confirm}
      >
        {holds.length > 0 && (
          <ul className="divide-y rounded-md border bg-card text-sm" aria-label="What leaves the configuration">
            {holds.map((m) => (
              <li key={m.label} className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
                <span className="w-32 shrink-0 text-muted-foreground">{m.label}</span>
                <span className="min-w-0 flex-1 font-mono text-xs break-all">{m.names.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
      {save.dialogs}
    </>
  );
}
