"use client";

import { ICONS } from "@/lib/icons";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteServerAction } from "@/app/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toastCopy } from "@/lib/toast-core";

/** How the agent reaches this dashboard: it is reached at an address (direct), it connects out and runs apps (server), or it connects out and serves no traffic (machine). */
export type ServerLink = "direct" | "server" | "machine";

/** Forgetting a server only removes it from this dashboard: the agent keeps running. Asks for the name first. */
export function DeleteServerButton({ serverId, name, link = "direct" }: { serverId: string; name: string; link?: ServerLink }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function remove() {
    setError(null);
    start(async () => {
      try {
        const refused = await deleteServerAction(serverId);
        if (refused?.error) {
          setError(refused.error);
          return;
        }
        // The action redirects to the overview; toasts live outside the page, so this survives the navigation.
        toast.success(toastCopy.removed(name), { description: link === "machine" ? "Its connection is revoked; nothing was deleted on the computer." : link === "server" ? "Its connection is revoked; the server keeps running and nothing was deleted on it." : "The server keeps running; only this dashboard forgot it." });
      } catch (err) {
        setError(err instanceof Error ? err.message : toastCopy.failed("removed", name));
      }
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null);
        setOpen(next);
      }}
      trigger={
        <Button variant="destructive">
          <ICONS.remove />
          Remove server
        </Button>
      }
      title={`Remove ${name} from the dashboard?`}
      description={
        link === "machine"
          ? "This dashboard forgets the machine and revokes its connection: its agent is refused and stops. Nothing changes on the computer itself. To use it again, connect it with a new code."
          : link === "server"
            ? "This dashboard forgets the server and revokes its connection: its agent is refused. Nothing changes on the server itself: its containers and the sites they serve keep running. To connect it again, run the install command with a new code."
            : "This dashboard forgets the server, its URL and its stored credentials. Nothing changes on the server itself: the agent, its containers and the sites they serve keep running. You can add the server again later with its token."
      }
      confirmLabel="Remove server"
      destructive
      typeToConfirm={name}
      pending={pending}
      error={error}
      onConfirm={remove}
    />
  );
}
