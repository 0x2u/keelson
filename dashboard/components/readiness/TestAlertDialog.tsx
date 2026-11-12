"use client";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { testAlertAction } from "@/app/readiness-actions";
import { GatedButton } from "@/components/GatedButton";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ICONS } from "@/lib/icons";
import { alertRows, alertSummary, readinessToast, type AlertRow } from "@/lib/readiness-run-core";

/**
 * Sends a test message through every alert channel of a server and says, channel by channel, whether it arrived. A failure
 * is a class (timed out, refused, rejected), never the agent's error text: that could quote a URL or a token.
 */
export function TestAlertDialog({ serverId, serverName, canDeploy, label = "Send a test alert" }: { serverId: string; serverName: string; canDeploy: boolean; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AlertRow[] | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    setError(null);
    setRows(null);
  }

  async function send() {
    setPending(true);
    setError(null);
    setRows(null);
    const out = await testAlertAction(serverId);
    setPending(false);
    if (out.error !== undefined) {
      setError(out.error);
      return;
    }
    const result = alertRows(out.result.channels);
    setRows(result);
    const summary = alertSummary(result);
    if (summary.ok) toast.success(readinessToast.alertDelivered);
    else toast.error(readinessToast.alertNotDelivered);
    router.refresh();
  }

  const summary = rows === null ? null : alertSummary(rows);

  return (
    <>
      <GatedButton canDeploy={canDeploy} type="button" variant="outline" size="xs" aria-label={`${label} from ${serverName}`} onClick={() => setOpen(true)}>
        <ICONS.notification />
        {label}
      </GatedButton>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a test alert from {serverName}</DialogTitle>
            <DialogDescription>Sends one test message through every alert channel of this server. It is not kept in the notification history.</DialogDescription>
          </DialogHeader>

          {error !== null && <Notice title="The test did not run">{error}</Notice>}
          {summary !== null && rows !== null && (
            <div className="space-y-3">
              <p className="text-sm font-medium">{summary.text}</p>
              {rows.length > 0 && (
                <ul className="divide-y rounded-lg border text-sm" data-testid="alert-result">
                  {rows.map((r, i) => (
                    <li key={`${r.channel}-${i}`} className="flex items-center gap-2 px-3 py-2">
                      {r.ok ? <CircleCheckIcon aria-hidden className="size-4 text-success-text" /> : <CircleAlertIcon aria-hidden className="size-4 text-destructive-text" />}
                      <span className="font-medium">{r.channel}</span>
                      <span className="text-muted-foreground">{r.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {rows !== null ? "Close" : "Cancel"}
            </Button>
            <Button type="button" loading={pending} onClick={() => void send()}>
              <ICONS.notification />
              {rows !== null ? "Send again" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
