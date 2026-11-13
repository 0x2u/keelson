"use client";

import { ArrowUpCircleIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { requestUpdateAction } from "@/app/update-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { busy, parsePayload, updateView, type FetchResult, type UpdateView } from "@/lib/updater-core";

const POLL_MS = 2000;
const FETCH_TIMEOUT_MS = 5000;
const STATUS_URL = "/api/update/status";

/** The run being followed: the version asked for and when the request was written (the dashboard's clock, which is the host's). */
interface Run {
  target: string;
  requestedAt: number;
}

async function fetchStatus(): Promise<FetchResult> {
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false };
    const payload = parsePayload(await res.json());
    return payload ? { ok: true, payload } : { ok: false };
  } catch {
    // The dashboard restarts during an update: no answer is expected for a while.
    return { ok: false };
  }
}

/**
 * Updates this dashboard to `tag` with one click (after confirming and unlocking), then follows the run: the host copies the
 * database, pulls the new version and restarts the dashboard, which is unreachable for about a minute. The panel keeps asking
 * until the dashboard answers again and says what became of the run.
 */
export function UpdateButton({ tag }: { tag: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [run, setRun] = useState<Run | null>(null);
  const [view, setView] = useState<UpdateView | null>(null);

  // A page opened while a run is going (a second tab, a reload before the restart) picks it up instead of offering the button again.
  useEffect(() => {
    let cancelled = false;
    void fetchStatus().then((result) => {
      if (cancelled || !result.ok) return;
      const { status } = result.payload;
      if (status === null || !busy(result.payload, Date.now())) return;
      setRun((current) => current ?? { target: status.to, requestedAt: status.startedAt });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (run === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = updateView({ ...run, now: Date.now(), result: await fetchStatus() });
      if (cancelled) return;
      setView(next);
      if (next.polling) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [run]);

  function confirm() {
    setError(null);
    start(async () => {
      try {
        const result = await requestUpdateAction(tag);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setOpen(false);
        setView({ kind: "waiting", text: "Waiting for the host to start the update…", polling: true });
        setRun({ target: result.version, requestedAt: result.requestedAt });
      } catch {
        setError("The dashboard did not answer.");
      }
    });
  }

  if (run !== null) {
    const kind = view?.kind ?? "waiting";
    const ended = view !== null && !view.polling;
    return (
      <div className="space-y-2" role="status" data-testid="update-progress" data-kind={kind}>
        <p className={`flex items-center gap-2 text-sm ${kind === "failed" || kind === "stalled" ? "text-destructive" : ""}`}>
          {!ended && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
          {view?.text ?? "Waiting for the host to start the update…"}
        </p>
        {kind === "done" && (
          <Button type="button" size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        )}
        {ended && kind !== "done" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRun(null);
              setView(null);
            }}
          >
            Close
          </Button>
        )}
      </div>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null);
        setOpen(next);
      }}
      trigger={
        <Button type="button" size="sm" data-testid="update-button">
          <ArrowUpCircleIcon />
          Update to {tag}
        </Button>
      }
      title={`Update the dashboard to ${tag}?`}
      description="The database is copied first. The dashboard restarts and is unreachable for about a minute. If the new version is not healthy, it returns by itself to the current one."
      confirmLabel={`Update to ${tag}`}
      pending={pending}
      error={error}
      onConfirm={confirm}
    />
  );
}
