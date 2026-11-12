import { Figure, EYEBROW, Orb } from "@/components/signature";
import type { DayBucket, FleetFigures, Headline } from "@/lib/home-core";
import { cn } from "@/lib/utils";

const BAR: Record<DayBucket["worst"], string> = {
  none: "bg-foreground/10",
  ok: "bg-foreground/45",
  warning: "bg-warning",
  failed: "bg-destructive",
};

const hourLabel = (from: number) => new Date(from).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/**
 * The last 24 hours as 24 bars, one per hour: as tall as the deployments in it, coloured only when it holds a failure or a
 * roll back. A quiet day is a flat line, a bad hour is visible from across the room. The same events as the list below it.
 */
export function DayRibbon({ buckets }: { buckets: DayBucket[] }) {
  const total = buckets.reduce((n, b) => n + b.deployments, 0);
  const bad = buckets.filter((b) => b.worst === "failed" || b.worst === "warning").length;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="day-ribbon">
      <p className={EYEBROW}>Last 24 hours</p>
      <ol className="flex h-24 items-end gap-[3px] border-b border-dashed pb-px" aria-label={`Last 24 hours, hour by hour: ${total} deployment${total === 1 ? "" : "s"}, ${bad === 0 ? "no hour with a failure" : `${bad} hour${bad === 1 ? "" : "s"} with a failure or a roll back`}`}>
        {buckets.map((b) => (
          <li key={b.from} className="flex h-full flex-1 items-end" title={`${hourLabel(b.from)} UTC: ${b.summary}`}>
            <span className={cn("block w-full rounded-[3px]", BAR[b.worst])} style={{ height: `${b.worst === "none" ? 4 : 18 + Math.min(b.deployments, 4) * 17}px` }} />
          </li>
        ))}
      </ol>
      <div aria-hidden className="flex justify-between text-[0.6875rem] text-muted-foreground">
        <span>24 h ago</span>
        <span>12 h</span>
        <span>now</span>
      </div>
      <p className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-foreground/45" /> deployments
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-warning" /> rolled back
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-[2px] bg-destructive" /> failed
        </span>
      </p>
    </div>
  );
}

/**
 * The first block of the home page: the state of the whole fleet said once, large, then three figures and the day. The
 * words are the headline the page always had ("All good", "2 things need attention"); the orb, figures and bars are the
 * same data drawn.
 */
export function FleetHero({ head, figures, buckets }: { head: Headline; figures: FleetFigures; buckets: DayBucket[] }) {
  const glow = head.tone === "success" || head.tone === "muted" ? "var(--brand)" : head.tone === "danger" ? "var(--destructive)" : head.tone === "warning" ? "var(--warning)" : "var(--info)";
  return (
    <section aria-label="Fleet status" className="relative overflow-hidden rounded-2xl border bg-card">
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(46rem 18rem at 0% -20%, color-mix(in srgb, ${glow} 13%, transparent), transparent 70%)` }} />
      <div className="relative grid gap-x-10 gap-y-6 p-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:p-7">
        <div className="min-w-0 space-y-6">
          <div className="flex items-center gap-4">
            <Orb tone={head.tone} />
            <div className="min-w-0">
              <p className="font-display text-3xl font-semibold tracking-tight" data-testid="status-line">
                <strong className="font-semibold text-foreground">{head.text}</strong>
              </p>
              {head.total > 0 && (
                <p className="text-sm text-muted-foreground">
                  {head.reachable} of {head.total} agent{head.total === 1 ? "" : "s"} reachable
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 border-t pt-5" data-testid="fleet-figures">
            <Figure label="Apps up" note={figures.appsTotal === 0 ? "none yet" : figures.appsUp === figures.appsTotal ? "all running" : `${figures.appsTotal - figures.appsUp} not running`} tone={figures.appsTotal > 0 && figures.appsUp < figures.appsTotal ? "danger" : "muted"}>
              {figures.appsUp}
              <span className="text-base font-medium text-muted-foreground"> / {figures.appsTotal}</span>
            </Figure>
            <Figure label="Deployments" note={figures.deployments === 0 ? "in 24 h" : figures.failedDeployments === 0 ? "in 24 h, none failed" : `in 24 h, ${figures.failedDeployments} did not succeed`} tone={figures.failedDeployments > 0 ? "warning" : "muted"}>
              {figures.deployments}
            </Figure>
            <Figure label="Backups" note={figures.backupsTotal === 0 ? "none scheduled" : figures.backupsHealthy === figures.backupsTotal ? "last run succeeded" : `${figures.backupsTotal - figures.backupsHealthy} need a look`} tone={figures.backupsTotal > 0 && figures.backupsHealthy < figures.backupsTotal ? "danger" : "muted"}>
              {figures.backupsTotal === 0 ? "–" : figures.backupsHealthy}
              {figures.backupsTotal > 0 && <span className="text-base font-medium text-muted-foreground"> / {figures.backupsTotal}</span>}
            </Figure>
          </div>
        </div>
        <DayRibbon buckets={buckets} />
      </div>
    </section>
  );
}
