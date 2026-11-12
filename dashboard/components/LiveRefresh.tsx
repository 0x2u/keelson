"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Refresher, type RefreshState } from "@/lib/live-refresh-core";
import { cn } from "@/lib/utils";

/** Fired on `window` when a page received fresh data: the sidebar listens to update its dots in step. */
export const REFRESHED_EVENT = "keelson:refreshed";

/** Whether the dashboard itself answers: a failed fetch or a 5xx. (A redirect to the sign-in page is followed and is fine: refreshing then sends the operator there.) */
async function dashboardAnswers(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.status < 500;
  } catch {
    return false;
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

/**
 * "Updated 12 s ago", and the reason the page keeps itself current: every 15 s while the tab is visible the server
 * components are re-rendered. When that fails the page says it is stale and that it is reconnecting, instead of
 * showing old values as current. `generatedAt` must change on every render of the page (it is the proof of fresh data).
 */
export function LiveRefresh({ generatedAt, className }: { generatedAt: number; className?: string }) {
  const router = useRouter();
  const refresher = useRef<Refresher | null>(null);
  const [state, setState] = useState<RefreshState>({ status: "live", failures: 0 });
  const updatedAt = generatedAt; // the server's render time: it changes with every refresh
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const r = new Refresher({
      isVisible: () => document.visibilityState === "visible",
      probe: dashboardAnswers,
      refresh: () => router.refresh(),
      onChange: setState,
    });
    refresher.current = r;
    const onVisibility = () => r.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    r.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      r.stop();
      refresher.current = null;
    };
  }, [router]);

  useEffect(() => {
    refresher.current?.confirm();
    window.dispatchEvent(new Event(REFRESHED_EVENT));
  }, [generatedAt]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const stale = state.status === "stale";
  const text = now === null ? "\u00a0" : ago(now - updatedAt);
  return (
    <p className={cn("flex items-center gap-1.5 text-xs", stale ? "font-medium text-warning-text" : "text-muted-foreground", className)} data-stale={stale || undefined}>
      <span aria-hidden className={cn("size-1.5 rounded-full", stale ? "animate-pulse bg-warning" : "bg-success")} />
      <span>{stale ? `Stale, reconnecting. Last updated ${text}` : `Updated ${text}`}</span>
      <span className="sr-only" role="status">
        {stale ? "Live updates are paused: the dashboard does not answer, retrying." : ""}
      </span>
    </p>
  );
}
