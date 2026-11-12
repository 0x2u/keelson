"use client";

import { ICONS } from "@/lib/icons";
import { useRef, useState } from "react";
import { ConnectionState, connectionView } from "@/components/ConnectionState";
import { RelativeTime } from "@/components/relative-time";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/states";
import { useEventStream, usePageVisible } from "@/components/useEventStream";
import type { Stats } from "@/lib/agent-types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

const HISTORY = 60; // about a minute: the agent samples once a second
const EVENTS = ["stats", "end", "error"] as const;

interface Sample extends Stats {
  /** Bytes per second since the previous sample. */
  rx_rate: number;
  tx_rate: number;
}

function isStats(data: unknown): data is Stats {
  return typeof data === "object" && data !== null && "cpu_percent" in data && "mem_usage" in data;
}

const WIDTH = 240;
const HEIGHT = 40;

/** The last HISTORY samples as a line with a soft fill, drawn in the current text colour. New samples enter from the right. */
function Sparkline({ values, max, label, className }: { values: number[]; max: number; label: string; className?: string }) {
  const top = Math.max(max, 1e-9);
  const offset = HISTORY - values.length;
  const points = values.map((v, i) => {
    const x = ((offset + i) / (HISTORY - 1)) * WIDTH;
    const y = HEIGHT - 2 - (Math.min(v, top) / top) * (HEIGHT - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0]?.split(",")[0] ?? "0";
  const lastX = points[points.length - 1]?.split(",")[0] ?? "0";
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label} className={cn("h-10 w-full", className)}>
      {points.length > 1 && (
        <>
          <polygon points={`${first},${HEIGHT} ${points.join(" ")} ${lastX},${HEIGHT}`} fill="currentColor" opacity="0.12" />
          <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

function Tile({ title, value, sub, stale, children }: { title: string; value: string; sub?: string; stale: boolean; children?: React.ReactNode }) {
  return (
    <Card className={cn("gap-2 px-4 py-4", stale && "opacity-60")}>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="text-2xl font-semibold tabular">{value}</p>
      <p className="min-h-4 text-xs text-muted-foreground tabular">{sub}</p>
      {children}
    </Card>
  );
}

export function LiveStats({ serverId, container, running }: { serverId: string; container: string; running: boolean }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const previous = useRef<Sample | undefined>(undefined);
  const visible = usePageVisible();

  const { status, reconnecting } = useEventStream(
    `/api/servers/${serverId}/containers/${encodeURIComponent(container)}/stats`,
    EVENTS,
    (event, data) => {
      if (event !== "stats" || !isStats(data)) return;
      const last = previous.current;
      const seconds = last ? (Date.parse(data.time) - Date.parse(last.time)) / 1000 : 0;
      const rate = (current: number, before: number | undefined) =>
        seconds > 0 && before !== undefined ? Math.max(0, (current - before) / seconds) : 0;
      const next: Sample = {
        ...data,
        rx_rate: rate(data.net_rx_bytes, last?.net_rx_bytes),
        tx_rate: rate(data.net_tx_bytes, last?.net_tx_bytes),
      };
      previous.current = next;
      setSamples((prev) => [...prev, next].slice(-HISTORY));
    },
    ["end"],
    { enabled: visible && running, autoReconnect: true },
  );

  if (!running) {
    return (
      <Card>
        <EmptyState icon={ICONS.activity} title="No live stats">
          Stats are sampled while the container runs. Start it to see CPU, memory, network and processes.
        </EmptyState>
      </Card>
    );
  }

  const view = connectionView(status, reconnecting, visible);
  const now = samples[samples.length - 1];
  // Values are shown dimmed whenever the stream is not delivering them.
  const stale = status !== "live" || !visible;

  if (!now) {
    return (
      <div className="space-y-3">
        <ConnectionState view={view} subject="Stats stream" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[8.5rem] rounded-xl" />
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          {status === "disconnected" || status === "ended" ? "No sample was received before the stream stopped." : "Waiting for the first sample."}
        </p>
      </div>
    );
  }

  const cpu = samples.map((s) => s.cpu_percent);
  const mem = samples.map((s) => s.mem_usage);
  const hasLimit = now.mem_limit > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ConnectionState view={view} subject="Stats stream" />
        {stale && (
          <span className="text-xs text-muted-foreground">
            Showing the last values, sampled <RelativeTime at={now.time} />.
          </span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile title="CPU" value={`${now.cpu_percent.toFixed(1)} %`} sub="100 % is one core" stale={stale}>
          <Sparkline values={cpu} max={Math.max(5, Math.max(...cpu) * 1.25)} label="CPU usage, last minute" className="text-info" />
        </Tile>
        <Tile
          title="Memory"
          value={formatBytes(now.mem_usage)}
          sub={hasLimit ? `${now.mem_percent.toFixed(1)} % of ${formatBytes(now.mem_limit)}` : "No memory limit set"}
          stale={stale}
        >
          {hasLimit && <Progress value={Math.min(100, now.mem_percent)} aria-label="Memory used of the limit" />}
          <Sparkline values={mem} max={Math.max(...mem) * 1.25} label="Memory usage, last minute" className="text-info" />
        </Tile>
        <Tile title="Network" value={`${formatBytes(now.rx_rate)}/s in`} sub={`${formatBytes(now.tx_rate)}/s out`} stale={stale}>
          <p className="text-xs text-muted-foreground tabular">
            Total {formatBytes(now.net_rx_bytes)} in, {formatBytes(now.net_tx_bytes)} out
          </p>
        </Tile>
        <Tile title="Processes" value={String(now.pids)} sub="PIDs in the container" stale={stale} />
      </div>
    </div>
  );
}
