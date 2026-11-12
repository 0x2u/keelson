import { ChevronDownIcon, HardDriveIcon, MemoryStickIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import type { ReactNode } from "react";
import type { AgentInfo, Container, DiskUsage, SystemInfo } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { assess, formatUptime, loadTone, usageTone } from "@/lib/health-core";
import { lastSeen, markSeen } from "@/lib/servers";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineLink, TableCard } from "@/components/layout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import { StatusDot } from "@/components/status";

const BAR: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
};

/** A horizontal gauge. The numbers beside it carry the meaning: the colour only says how worried to be. */
function Gauge({ used, total, tone, label }: { used: number; total: number; tone: Tone; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Metric({ label, icon: Icon, children }: { label: string; icon: typeof ICONS.resources; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4" />
        {label}
      </div>
      {children}
    </div>
  );
}

const unknown = <p className="text-sm text-muted-foreground">Not available</p>;

/** Reachability, load, memory, disk and the engine on one card, and the verdict in its header. */
export async function ServerHealth({
  serverId,
  info,
  system,
  containers,
}: {
  serverId: string;
  info: Promise<Loaded<AgentInfo>>;
  system: Promise<Loaded<SystemInfo | null>>;
  containers: Promise<Loaded<Container[]>>;
}) {
  const [infoResult, systemResult, containerResult] = await Promise.all([info, system, containers]);
  const reachable = infoResult.error === undefined;
  if (reachable) markSeen(serverId);
  const seen = lastSeen(serverId);

  if (!reachable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Resources
            <Badge variant="danger">
              <StatusDot tone="danger" />
              Unreachable
            </Badge>
          </CardTitle>
          <CardDescription>
            {seen === null ? (
              "This dashboard has never had an answer from this agent."
            ) : (
              <>
                Last answered <RelativeTime at={seen} /> (as seen by this dashboard).
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (systemResult.error !== undefined || systemResult.data === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>
            {systemResult.error !== undefined ? (
              <>The agent answers, but not its health overview: {systemResult.error}.</>
            ) : (
              <>
                This agent is older than the health overview.{" "}
                <InlineLink href={`/servers/${serverId}/update`}>Update it</InlineLink>{" "}
                to see load, memory and disk here.
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const sys = systemResult.data;
  const { host, engine } = sys;
  const verdict = assess(sys, containerResult.data);
  const memUsed = host.memory ? host.memory.total - host.memory.available : 0;
  const diskUsed = host.disk ? host.disk.total - host.disk.free : 0;
  const swapUsed = host.memory ? host.memory.swap_total - host.memory.swap_free : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Resources
          <Badge variant={verdict.tone}>
            <StatusDot tone={verdict.tone} />
            {verdict.tone === "success" ? "Everything is fine" : verdict.tone === "danger" ? "Needs attention" : "Worth a look"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {verdict.reasons.length > 0 ? verdict.reasons.join(" · ") : "Load, memory, disk and containers are all within limits."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Load" icon={ICONS.activity}>
          {host.load ? (
            <>
              <p className="text-xl tabular">
                {host.load.one.toFixed(2)}
                <span className="ml-2 text-sm text-muted-foreground">
                  {host.load.five.toFixed(2)} · {host.load.fifteen.toFixed(2)}
                </span>
              </p>
              <Gauge used={host.load.one} total={host.cpus} tone={loadTone(host.load.one, host.cpus)} label="Load against CPU count" />
              <p className="text-xs text-muted-foreground">
                1, 5 and 15 min on {host.cpus} CPU{host.cpus === 1 ? "" : "s"}
              </p>
            </>
          ) : (
            unknown
          )}
        </Metric>
        <Metric label="Memory" icon={MemoryStickIcon}>
          {host.memory ? (
            <>
              <p className="text-xl tabular">
                {formatBytes(memUsed)}
                <span className="ml-2 text-sm text-muted-foreground">of {formatBytes(host.memory.total)}</span>
              </p>
              <Gauge used={memUsed} total={host.memory.total} tone={usageTone(memUsed, host.memory.total)} label="Memory in use" />
              <p className="text-xs text-muted-foreground">
                {formatBytes(host.memory.available)} available
                {host.memory.swap_total > 0 && ` · swap ${formatBytes(swapUsed)} of ${formatBytes(host.memory.swap_total)}`}
              </p>
            </>
          ) : (
            unknown
          )}
        </Metric>
        <Metric label="Disk" icon={HardDriveIcon}>
          {host.disk ? (
            <>
              <p className="text-xl tabular">
                {formatBytes(host.disk.free)}
                <span className="ml-2 text-sm text-muted-foreground">free of {formatBytes(host.disk.total)}</span>
              </p>
              <Gauge used={diskUsed} total={host.disk.total} tone={usageTone(diskUsed, host.disk.total)} label="Disk in use" />
              <p className="truncate font-mono text-xs text-muted-foreground" title={host.disk.path}>
                {host.disk.path}
              </p>
            </>
          ) : (
            unknown
          )}
        </Metric>
        <Metric label="Engine" icon={ICONS.server}>
          {engine ? (
            <>
              <p className="text-xl tabular">Docker {engine.version}</p>
              <p className="text-xs text-muted-foreground">
                {engine.running} running of {engine.containers} containers · {engine.images} images
              </p>
            </>
          ) : (
            <p className="text-sm text-destructive-text">{sys.engine_error ?? "Not available"}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {host.uptime_seconds !== undefined && <>Up {formatUptime(host.uptime_seconds)} · </>}
            answering now
          </p>
        </Metric>
      </CardContent>
    </Card>
  );
}

const AGE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 months ago" for an image's creation date (Unix seconds). */
function age(created: number, now: number): string {
  const days = Math.round((created * 1000 - now) / 86_400_000);
  if (Math.abs(days) < 60) return AGE.format(days, "day");
  return AGE.format(Math.round(days / 30), "month");
}

/** What Docker keeps on disk, and what could go: the engine's own accounting, so it is slow to load. */
export async function DockerDisk({ info, disk }: { info: Promise<Loaded<AgentInfo>>; disk: Promise<Loaded<DiskUsage | null>> }) {
  const [infoResult, result] = await Promise.all([info, disk]);
  // An unreachable agent is said once, by the health card; an older one has nothing to show.
  if (infoResult.error !== undefined || result.data === null) return null;
  if (result.error !== undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Docker disk usage</CardTitle>
          <CardDescription>Could not be read: {result.error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const u = result.data;
  const now = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const rows: { label: string; size: number; detail: string }[] = [
    {
      label: "Images",
      size: u.images.size,
      detail: u.images.unused === 0 ? `${u.images.count}, all in use` : `${u.images.count} (${u.images.unused} unused, at least ${formatBytes(u.images.reclaimable)} to free)`,
    },
    { label: "Containers", size: u.containers.size, detail: `${u.containers.count}, writable layers only` },
    { label: "Volumes", size: u.volumes.size, detail: `${u.volumes.count}${u.volumes.unused > 0 ? ` (${u.volumes.unused} unused)` : ""}` },
    {
      label: "Build cache",
      size: u.build_cache.size,
      detail: `${u.build_cache.count} entries, ${formatBytes(u.build_cache.reclaimable)} not in use`,
    },
  ];

  const total = rows.reduce((sum, r) => sum + r.size, 0);
  const reclaimable = u.images.reclaimable + u.build_cache.reclaimable;

  return (
    <TableCard>
      <details className="group" data-testid="docker-disk">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="leading-none font-semibold">Docker disk usage</span>
            <span className="text-sm text-muted-foreground tabular">
              {formatBytes(total)}
              {reclaimable > 0 && ` · at least ${formatBytes(reclaimable)} could be freed`}
            </span>
          </span>
          <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-6 pb-4">
        <p className="px-4 text-sm text-muted-foreground">
          Container logs are not counted: the agent does not read the engine&apos;s data directory. They are rotated by default. The agent
          already removes an app&apos;s old images after each deployment (<code className="font-mono text-xs">keep_images</code>).
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="hidden sm:table-cell">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right tabular">{formatBytes(r.size)}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{r.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {u.images.largest.length > 0 && (
          <div className="space-y-2">
            <h3 className="px-4 text-sm font-medium">
              Unused images
              {u.images.unused > u.images.largest.length && (
                <span className="ml-2 font-normal text-muted-foreground">the {u.images.largest.length} largest of {u.images.unused}</span>
              )}
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Image</TableHead>
                  <TableHead className="text-right">Frees</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {u.images.largest.map((img) => (
                  <TableRow key={img.id}>
                    <TableCell className="max-w-0 truncate font-mono text-xs" title={(img.tags ?? []).join(", ") || img.id}>
                      {img.tags && img.tags.length > 0 ? img.tags.join(", ") : <span className="text-muted-foreground">untagged {img.id.replace("sha256:", "").slice(0, 12)}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular">{formatBytes(img.size)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{age(img.created, now)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        </div>
      </details>
    </TableCard>
  );
}
