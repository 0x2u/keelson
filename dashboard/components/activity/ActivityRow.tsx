import { ArrowRightIcon, BellIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import type { ComponentType } from "react";
import { ImageRef } from "@/components/image-ref";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { eventStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import type { ActivityEvent, FeedUnanswered } from "@/lib/activity-core";
import type { FeedKind } from "@/lib/activity-core";
import { cantTell } from "@/lib/attention-core";
import { cn } from "@/lib/utils";

const KIND_VIEW: Record<FeedKind, { icon: ComponentType<{ className?: string }>; label: string }> = {
  deployment: { icon: ICONS.deploy, label: "Deployment" },
  job: { icon: ICONS.job, label: "Job" },
  backup: { icon: ICONS.database, label: "Backup" },
  alert: { icon: BellIcon, label: "Alert" },
  change: { icon: ICONS.configuration, label: "Configuration change" },
  security: { icon: ShieldIcon, label: "Security" },
};

const linkClass = "underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

/** "Deployed web" with the app as a link: the subject is the part of the sentence that names a page. */
function Summary({ event }: { event: ActivityEvent }) {
  const { summary, subject } = event;
  const at = subject?.href ? summary.indexOf(subject.label) : -1;
  if (!subject?.href || at < 0) return <>{summary}</>;
  return (
    <>
      {summary.slice(0, at)}
      <Link href={subject.href} className={cn(linkClass, "font-semibold")}>
        {subject.label}
      </Link>
      {summary.slice(at + subject.label.length)}
    </>
  );
}

/** One thing that happened: what it was and its status on the first line, where, who and why below, when on the right. */
export function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon: Icon, label } = KIND_VIEW[event.kind];
  const edge = event.failed ? (event.tone === "warning" ? "border-l-warning" : "border-l-destructive") : "border-l-transparent";
  return (
    <li data-kind={event.kind} data-failed={event.failed || undefined} className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-l-2 px-4 py-3", edge)}>
      <span className="mt-0.5 flex size-7 items-center justify-center rounded-full border bg-muted text-muted-foreground" title={label}>
        <Icon className="size-3.5" aria-hidden />
        <span className="sr-only">{label}</span>
      </span>
      <div className="min-w-0 space-y-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 break-words">
            <Summary event={event} />
          </span>
          {event.ref !== undefined && <ImageRef value={event.ref} copy={false} className="max-w-72" />}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {event.server ? (
            <Link href={`/servers/${event.server.id}`} className={cn(linkClass, "font-medium")}>
              {event.server.name}
            </Link>
          ) : (
            <span>Dashboard</span>
          )}
          {event.severity !== undefined && <span>· {event.severity}</span>}
          {event.trigger !== undefined && <span>· {event.trigger}</span>}
          {event.actor !== undefined && <span>· by {event.actor}</span>}
          {event.note !== undefined && (
            <span className={cn("min-w-0 max-w-full truncate", event.failed && event.tone !== "muted" ? "text-destructive-text" : undefined)} title={event.note}>
              · {event.note}
            </span>
          )}
          {event.outputHref !== undefined && (
            <Link href={event.outputHref} className={cn(linkClass, "font-medium")}>
              · Output
            </Link>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          <StatusBadge view={eventStatus(event)} />
          <RelativeTime at={event.at} className="text-xs whitespace-nowrap text-muted-foreground" />
        </div>
        {event.href !== undefined ? (
          <Button asChild variant="ghost" size="icon-sm">
            <Link href={event.href} aria-label={`Open: ${event.summary}${event.server ? ` on ${event.server.name}` : ""}`}>
              <ArrowRightIcon />
            </Link>
          </Button>
        ) : (
          <span className="size-8" aria-hidden />
        )}
      </div>
    </li>
  );
}

/** A server that did not answer: a row of its own, in its place at the top, rather than an absence. */
export function UnansweredRow({ server }: { server: FeedUnanswered }) {
  return (
    <li data-unanswered={server.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-l-2 border-l-warning bg-warning/5 px-4 py-3">
      <span className="flex size-7 items-center justify-center rounded-full border bg-muted text-warning-text">
        <TriangleAlertIcon className="size-3.5" aria-hidden />
      </span>
      <p className="min-w-0 text-sm">
        {cantTell([server])}
        <span className="block text-xs text-muted-foreground">Its deployments, jobs and audit log are missing from this list until it answers.</span>
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href={`/servers/${server.id}`}>Open {server.name}</Link>
      </Button>
    </li>
  );
}
