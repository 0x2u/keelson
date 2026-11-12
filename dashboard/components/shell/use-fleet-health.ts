"use client";

import { useEffect, useState } from "react";
import { REFRESHED_EVENT } from "@/components/LiveRefresh";
import type { ProjectDotStatus } from "@/lib/project-dot-core";
import type { ServerDotStatus } from "@/lib/server-dot-core";

const REFRESH_MS = 15_000;

export interface FleetHealth {
  /** By server id. */
  servers: Record<string, ServerDotStatus>;
  /** The projects the servers' apps make up, with where the worst environment of each stands; empty until the first answer. */
  projects: ProjectDotStatus[];
}

const NONE: FleetHealth = { servers: {}, projects: [] };

/**
 * What the sidebar's dots show, per server and per project: the attention model's verdict (the same one the home page lists)
 * and the worst environment of each project. Polled every 15 s while the tab is visible, and again the moment a page
 * received fresh data, so a problem that appears on the page appears on the dot. Empty (every dot grey) when the dashboard
 * itself cannot be reached: never a stale "online".
 */
export function useFleetHealth(): FleetHealth {
  const [health, setHealth] = useState<FleetHealth>(NONE);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/fleet/health", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body: { servers: ServerDotStatus[]; projects: ProjectDotStatus[] } = await res.json();
        if (!cancelled) setHealth({ servers: Object.fromEntries(body.servers.map((s) => [s.id, s])), projects: body.projects });
      } catch {
        if (!cancelled) setHealth(NONE);
      } finally {
        inFlight = false;
      }
    }

    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        void refresh();
        timer = window.setTimeout(schedule, REFRESH_MS);
      }
    }

    const onRefreshed = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    schedule();
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener(REFRESHED_EVENT, onRefreshed);
    };
  }, []);

  return health;
}
