import Link from "next/link";
import { ICONS } from "@/lib/icons";
import type { StatsHistory as History } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { RANGES, coverage, niceMax, rangeSeconds, shape, type Coverage, type Range } from "@/lib/history-core";
import { cn } from "@/lib/utils";
import { FOCUS_RING, FormCard } from "@/components/layout";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";

const WIDTH = 600;
const HEIGHT = 120;

function ago(seconds: number): string {
  return seconds >= 3600 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 60)} min ago`;
}

/** One chart: the average line with its area, the pale peak line, three gridlines, and the average and peak in words. */
export function Chart<P extends { time: string }>({
  title,
  points,
  pick,
  max,
  format,
  from,
  to,
  gap,
  range,
}: {
  title: string;
  points: P[];
  pick: (p: P) => { avg: number; peak: number };
  max: number;
  format: (v: number) => string;
  from: number;
  to: number;
  gap: number;
  range: Range;
}) {
  const s = shape(points, pick, from, to, max, WIDTH, HEIGHT, gap);
  const avg = points.reduce((sum, p) => sum + pick(p).avg, 0) / points.length;
  const peak = Math.max(...points.map((p) => pick(p).peak));
  const runs = (str: string) => str.split(" | ");
  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground tabular">
          average {format(avg)} · peak {format(peak)}
        </span>
      </figcaption>
      <div className="relative text-primary">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} over the last ${range}: average ${format(avg)}, peak ${format(peak)}`}
          className="h-32 w-full overflow-visible"
        >
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1="0" x2={WIDTH} y1={HEIGHT * f} y2={HEIGHT * f} stroke="currentColor" opacity="0.12" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          ))}
          {runs(s.area).map((a, i) => (
            <polygon key={`a${i}`} points={a} fill="currentColor" opacity="0.12" />
          ))}
          {runs(s.peak).map((p, i) => (
            <polyline key={`p${i}`} points={p} fill="none" stroke="currentColor" opacity="0.35" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {runs(s.line).map((l, i) => (
            <polyline key={`l${i}`} points={l} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <span className="pointer-events-none absolute top-0 left-0 -translate-y-1/2 bg-card pr-1 text-[10px] text-muted-foreground tabular">{format(max)}</span>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{ago(rangeSeconds(range))}</span>
        <span>now</span>
      </div>
    </figure>
  );
}

/** The switch of a card between ranges (1 h / 6 h / 24 h by default): links, so the range lives in the URL. */
export function RangeNav<R extends string = Range>({ label, href, range, ranges = RANGES as unknown as readonly R[] }: { label: string; href: (r: R) => string; range: R; ranges?: readonly R[] }) {
  return (
    <nav aria-label={label} className="flex gap-1">
      {ranges.map((r) => (
        <Link
          key={r}
          href={href(r)}
          scroll={false}
          aria-current={r === range ? "true" : undefined}
          className={cn("rounded-md px-2.5 py-1 text-sm", FOCUS_RING, r === range ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}
        >
          {r}
        </Link>
      ))}
    </nav>
  );
}

/** Says that a chart is short on data (recording only just began, or began part-way through the range) rather than leaving it to look like a quiet machine. */
export function CoverageNote({ coverage: c }: { coverage: Coverage }) {
  if (c.kind === "starting") {
    return (
      <p className="text-xs text-muted-foreground">
        Recording started <RelativeTime at={c.since} />: only a few samples so far, the charts fill in as more arrive.
      </p>
    );
  }
  if (c.kind === "partial") {
    return (
      <p className="text-xs text-muted-foreground">
        Recorded since <RelativeTime at={c.since} />: nothing earlier is available.
      </p>
    );
  }
  return null;
}

/** CPU and memory over the last hour, six hours or day, from what the agent recorded: the app's, across its deployments. */
export async function StatsHistory({ href, range, history, title = "History" }: { href: (r: Range) => string; range: Range; history: Promise<Loaded<History | null>>; title?: string }) {
  const result = await history;
  const to = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const from = to - rangeSeconds(range) * 1000;

  let body;
  if (result.error !== undefined) {
    body = <Notice title="The history could not be read">{result.error}</Notice>;
  } else if (result.data === null) {
    body = (
      <EmptyState icon={ICONS.history} title="This agent records no history">
        The agent keeps it once deployments are enabled (it uses the agent&apos;s database), in a version that has the feature.
      </EmptyState>
    );
  } else if (result.data.points.length === 0) {
    body = (
      <EmptyState icon={ICONS.history} title="No samples yet">
        The agent samples every running container every 30 seconds and keeps a day. A container that has just started shows up after its first sample.
      </EmptyState>
    );
  } else {
    const { points, step_seconds: step } = result.data;
    const gap = step * 3 * 1000;
    const peakMem = Math.max(...points.map((p) => p.mem_max));
    const peakCpu = Math.max(...points.map((p) => p.cpu_max));
    body = (
      <>
        <CoverageNote coverage={coverage(points, from, to, step)} />
        <div className="grid gap-6 lg:grid-cols-2">
          <Chart
            title="CPU"
            points={points}
            pick={(p) => ({ avg: p.cpu_percent, peak: p.cpu_max })}
            max={niceMax(peakCpu, 10)}
            format={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`}
            from={from}
            to={to}
            gap={gap}
            range={range}
          />
          <Chart
            title="Memory"
            points={points}
            pick={(p) => ({ avg: p.mem_usage, peak: p.mem_max })}
            max={Math.max(peakMem * 1.15, 1 << 20)}
            format={formatBytes}
            from={from}
            to={to}
            gap={gap}
            range={range}
          />
        </div>
      </>
    );
  }

  return (
    <FormCard title={title} description="CPU is in percent of one core. The pale line is the peak inside each point." action={<RangeNav label="History range" href={href} range={range} />}>
      {body}
    </FormCard>
  );
}
