"use client";

import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { testAlertAction } from "@/app/readiness-actions";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hasAlertChannel } from "@/lib/notifications-core";
import type { NotificationsRow } from "@/lib/notifications-fleet-core";
import { ICONS } from "@/lib/icons";
import { alertRows, alertSummary, type AlertRow } from "@/lib/readiness-run-core";

/** How many servers are asked at once. */
const CONCURRENCY = 4;

type Progress = { status: "waiting" } | { status: "sending" } | { status: "done"; rows: AlertRow[] } | { status: "failed"; message: string };

/** A server a test alert can be sent from: it answered, can be signed for, and has a channel that says an alert. */
export const testable = (r: NotificationsRow): boolean => r.state === "ok" && r.channels !== undefined && hasAlertChannel(r.channels);

/**
 * Sends a test message from every server that has an alert channel and says, server by server and channel by channel, whether
 * it arrived. A failure is a class (timed out, refused, rejected), never the text of an error: that could quote a URL or a token.
 */
export function TestAllDialog({ rows }: { rows: NotificationsRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [ran, setRan] = useState(false);
  const targets = rows.filter(testable);
  const finished = ran && !running;

  function onOpenChange(next: boolean) {
    if (running) return;
    setOpen(next);
    if (!next && ran) router.refresh();
    if (!next) {
      setRan(false);
      setProgress({});
    }
  }

  async function sendAll() {
    setRan(true);
    setRunning(true);
    setProgress(Object.fromEntries(targets.map((t) => [t.id, { status: "waiting" } as Progress])));
    const queue = [...targets];
    const set = (id: string, p: Progress) => setProgress((all) => ({ ...all, [id]: p }));
    async function worker() {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        set(t.id, { status: "sending" });
        try {
          const out = await testAlertAction(t.id);
          set(t.id, out.error === undefined ? { status: "done", rows: alertRows(out.result.channels) } : { status: "failed", message: out.error });
        } catch {
          set(t.id, { status: "failed", message: "The request failed before the agent answered." });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    setRunning(false);
  }

  const results = targets.map((t) => progress[t.id]).filter((p): p is Progress => p !== undefined);
  const delivered = results.filter((p) => p.status === "done" && alertSummary(p.rows).ok).length;

  return (
    <>
      <Button type="button" variant="outline" disabled={targets.length === 0} onClick={() => setOpen(true)}>
        <ICONS.notification />
        Test all
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send a test alert from {targets.length} {targets.length === 1 ? "server" : "servers"}</DialogTitle>
            <DialogDescription>Sends one test message through every alert channel of each server below. It is not kept in the notification history.</DialogDescription>
          </DialogHeader>

          {finished && (
            <Notice tone={delivered === targets.length ? "info" : "warning"}>
              {delivered === targets.length ? `Delivered from all ${targets.length} servers.` : `Delivered from ${delivered} of ${targets.length} servers. The others are listed below with the reason.`}
            </Notice>
          )}

          <ul className="divide-y rounded-lg border text-sm" data-testid="test-all">
            {targets.map((t) => (
              <li key={t.id} className="space-y-1 px-3 py-2" data-server={t.id}>
                <ServerProgress name={t.name} p={progress[t.id]} />
              </li>
            ))}
          </ul>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
              {finished ? "Close" : "Cancel"}
            </Button>
            <Button type="button" loading={running} onClick={() => void sendAll()}>
              <ICONS.notification />
              {finished ? "Send again" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ServerProgress({ name, p }: { name: string; p: Progress | undefined }) {
  const summary = p?.status === "done" ? alertSummary(p.rows) : null;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{name}</span>
        {p?.status === "waiting" && <span className="text-xs text-muted-foreground">Waiting</span>}
        {p?.status === "sending" && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
            Sending
          </span>
        )}
        {p?.status === "failed" && <span className="text-xs font-medium text-destructive-text">Did not run</span>}
        {summary !== null && <span className={summary.ok ? "text-xs font-medium text-success-text" : "text-xs font-medium text-destructive-text"}>{summary.ok ? "Delivered" : "Not delivered"}</span>}
      </div>
      {p?.status === "done" && (
        <ul className="space-y-0.5 pl-1 text-xs text-muted-foreground">
          {p.rows.map((r, i) => (
            <li key={`${r.channel}-${i}`} className="flex items-center gap-1.5">
              {r.ok ? <CircleCheckIcon aria-hidden className="size-3.5 text-success-text" /> : <CircleAlertIcon aria-hidden className="size-3.5 text-destructive-text" />}
              <span className="font-medium text-foreground">{r.channel}</span> {r.text}
            </li>
          ))}
        </ul>
      )}
      {p?.status === "failed" && <p className="text-xs text-destructive-text">{p.message}</p>}
    </>
  );
}
