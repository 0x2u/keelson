import { ICONS } from "@/lib/icons";
import type { HostHistory as History } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { coverage, niceMax, rangeSeconds, withValue, type Range } from "@/lib/history-core";
import { FormCard } from "@/components/layout";
import { EmptyState, Notice } from "@/components/states";
import { Chart, CoverageNote, RangeNav } from "@/components/StatsHistory";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const percent = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;

/** Load, memory and disk of the machine over the last hour, six hours or day, from what the agent recorded. */
export async function HostHistory({ serverId, range, history }: { serverId: string; range: Range; history: Promise<Loaded<History | null>> }) {
  const result = await history;
  const to = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const from = to - rangeSeconds(range) * 1000;

  let body;
  if (result.error !== undefined) {
    body = <Notice title="The resource history could not be read">{result.error}</Notice>;
  } else if (result.data === null) {
    body = (
      <EmptyState icon={ICONS.history} title="No resource history yet">
        A server records it once it is set up for deployments and runs a recent version of Keelson.
      </EmptyState>
    );
  } else if (result.data.points.length === 0) {
    body = (
      <EmptyState icon={ICONS.history} title="No samples yet">
        The server samples its resources every 30 seconds and keeps a day: the first points show up about a minute after it starts.
      </EmptyState>
    );
  } else {
    const { points, step_seconds: step, cpus } = result.data;
    const gap = step * 3 * 1000;
    const shared = { from, to, gap, range };
    const load = withValue(points, "load");
    const mem = withValue(points, "mem_percent");
    const disk = withValue(points, "disk_percent");
    const peakLoad = Math.max(...load.map((p) => (p.load_max ?? p.load ?? 0) / cpus));
    const missing = <p className="text-sm text-muted-foreground">Not available on this server</p>;
    body = (
      <>
        <CoverageNote coverage={coverage(points, from, to, step)} />
        <div className="grid gap-6 lg:grid-cols-3">
          {load.length > 0 ? (
            <Chart
              title="Load per CPU"
              points={load}
              pick={(p) => ({ avg: (p.load ?? 0) / cpus, peak: (p.load_max ?? p.load ?? 0) / cpus })}
              max={niceMax(peakLoad, 1)}
              format={(v) => v.toFixed(2)}
              {...shared}
            />
          ) : (
            missing
          )}
          {mem.length > 0 ? (
            <Chart title="Memory used" points={mem} pick={(p) => ({ avg: p.mem_percent ?? 0, peak: p.mem_percent_max ?? p.mem_percent ?? 0 })} max={100} format={percent} {...shared} />
          ) : (
            missing
          )}
          {disk.length > 0 ? (
            <Chart title="Disk used" points={disk} pick={(p) => ({ avg: p.disk_percent ?? 0, peak: p.disk_percent_max ?? p.disk_percent ?? 0 })} max={100} format={percent} {...shared} />
          ) : (
            missing
          )}
        </div>
      </>
    );
  }

  return (
    <FormCard
      title="Resources over time"
      description="Load is the 1 minute average per CPU: 1.00 means every CPU is busy. Memory leaves out what can be reclaimed. The pale line is the peak inside each point."
      action={<RangeNav label="Resources range" href={(r) => `/servers/${serverId}?range=${r}`} range={range} />}
    >
      {body}
    </FormCard>
  );
}

/** Placeholder with the card's geometry: a title, its range switch and three chart-sized blocks. */
export function HostHistorySkeleton() {
  return (
    <Card aria-hidden>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
