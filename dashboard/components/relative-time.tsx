"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTimeTick, timeAgo, timeUntil } from "@/lib/format";

const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/**
 * "3 min ago" / "in 5 min", with the exact local time on hover and on keyboard focus. `at` is an ISO string, epoch
 * milliseconds or a Date. It re-renders every 30 s (every second while the instant is under two minutes away, so
 * "Started 12 s ago" counts up) so the page never shows an hour-old "just now". The text is computed on the client
 * only: the server and the browser disagree on the clock and the time zone.
 */
export function RelativeTime({ at, future = false, className }: { at: string | number | Date; future?: boolean; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  const ms = new Date(at).getTime();

  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      id = setTimeout(tick, relativeTimeTick(ms));
    };
    tick();
    return () => clearTimeout(id);
  }, [ms]);

  const date = new Date(ms);
  const valid = !Number.isNaN(ms);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time dateTime={typeof at === "string" ? at : valid ? date.toISOString() : undefined} tabIndex={0} className={className} suppressHydrationWarning>
            {now === null ? "\u00a0" : future ? timeUntil(ms, now) : timeAgo(ms, now)}
          </time>
        </TooltipTrigger>
        <TooltipContent>{valid ? absolute.format(date) : "Unknown time"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
