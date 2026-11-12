import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { DeploymentBadge, ServerStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineLink, TableCard } from "@/components/layout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import type { ServerRow } from "@/lib/servers-view-core";

const DISK_TEXT = { success: "text-muted-foreground", warning: "text-warning-text", danger: "text-destructive-text", info: "text-muted-foreground", muted: "text-muted-foreground" } as const;

/** Stands where a number would be when the server did not answer: unknown, never zero. */
const cantTell = <span className="text-muted-foreground">Can&apos;t tell</span>;

function Status({ row }: { row: ServerRow }) {
  if (!row.reachable) {
    return (
      <div className="space-y-1">
        <ServerStatusBadge reachable={false} machine={row.machine} />
        <p className="max-w-56 truncate text-xs text-muted-foreground" title={row.reason}>
          {row.relay ? "Its agent is not running or not connected" : (row.reason ?? "no answer")}
        </p>
        <p className="text-xs text-muted-foreground">
          {row.lastSeen === null ? (
            row.relay ? "Never connected" : "Never answered this dashboard"
          ) : (
            <>
              {row.relay ? "Last seen" : "Last answered"} <RelativeTime at={row.lastSeen} />
            </>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <ServerStatusBadge reachable machine={row.machine} attention={row.verdict} />
      {row.headline && (
        <p className="max-w-56 truncate text-xs text-muted-foreground" title={row.headline}>
          {row.headline}
        </p>
      )}
    </div>
  );
}

/** Every server, the ones that need a look first: whether it answers, its agent, what runs on it, the last deployment and the disk. */
export function ServersList({ rows }: { rows: ServerRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        bordered
        icon={ICONS.server}
        title="No servers yet"
        action={
          <Button asChild size="sm">
            <Link href="/servers/new">Add server</Link>
          </Button>
        }
      >
        Run one command on a server: its Keelson agent installs itself and connects out to this dashboard.
      </EmptyState>
    );
  }
  return (
    <TableCard>
      <Table data-testid="servers">
        <TableHeader>
          <TableRow>
            <TableHead>Server</TableHead>
            <TableHead className="hidden sm:table-cell">Status</TableHead>
            <TableHead className="hidden lg:table-cell">Agent</TableHead>
            <TableHead className="hidden md:table-cell">Apps</TableHead>
            <TableHead className="hidden md:table-cell">Containers</TableHead>
            <TableHead className="hidden lg:table-cell">Last deployment</TableHead>
            <TableHead className="hidden xl:table-cell">Disk</TableHead>
            <TableHead className="hidden xl:table-cell">Memory</TableHead>
            <TableHead className="hidden xl:table-cell">Load</TableHead>
            <TableHead>
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-server={row.id}>
              <TableCell className="w-full max-w-0 sm:w-auto sm:max-w-56">
                <InlineLink href={`/servers/${row.id}`} className="block truncate">
                  {row.name}
                </InlineLink>
                {row.relay ? (
                  <p className="truncate text-xs text-muted-foreground">{row.machine ? "Connects to Keelson · builds images" : "Connects to Keelson"}</p>
                ) : (
                  <p className="truncate font-mono text-xs text-muted-foreground" title={row.url}>
                    {row.url}
                  </p>
                )}
                {/* On a phone the status goes under the name; from sm up it has a column of its own. */}
                <div className="mt-1.5 sm:hidden">
                  <Status row={row} />
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <Status row={row} />
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {row.version !== undefined ? (
                  <div className="space-y-1">
                    <span className="tabular">{row.version}</span>
                    {row.readOnly && (
                      <Badge variant="muted" className="ml-2">
                        Read-only
                      </Badge>
                    )}
                    {row.newerThanDashboard && <p className="text-xs">Newer than this dashboard</p>}
                    {row.updateAvailable && (
                      <p>
                        <InlineLink href={`/servers/${row.id}/update`} className="text-xs text-info">
                          Update available
                        </InlineLink>
                      </p>
                    )}
                  </div>
                ) : (
                  cantTell
                )}
              </TableCell>
              <TableCell className="hidden tabular md:table-cell">
                {row.apps === undefined ? cantTell : row.apps === null ? <span className="text-muted-foreground">Read-only</span> : row.apps}
              </TableCell>
              <TableCell className="hidden tabular md:table-cell">
                {row.containers ? (
                  <>
                    {row.containers.running}
                    <span className="text-muted-foreground"> of {row.containers.total} running</span>
                  </>
                ) : (
                  cantTell
                )}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {row.apps === null ? (
                  <span className="text-muted-foreground">–</span>
                ) : row.lastDeployment === undefined ? (
                  cantTell
                ) : row.lastDeployment === null ? (
                  <span className="text-muted-foreground">Never</span>
                ) : (
                  <InlineLink href={`/servers/${row.id}/deployments/${row.lastDeployment.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-normal">
                    <DeploymentBadge status={row.lastDeployment.status} trigger={row.lastDeployment.trigger} />
                    <span className="text-xs text-muted-foreground">
                      {row.lastDeployment.app} · <RelativeTime at={row.lastDeployment.at} />
                    </span>
                  </InlineLink>
                )}
              </TableCell>
              <TableCell className="hidden tabular xl:table-cell">
                {row.disk ? (
                  <span className={DISK_TEXT[row.disk.tone]}>
                    {formatBytes(row.disk.free)} <span className="text-muted-foreground">free of {formatBytes(row.disk.total)}</span>
                  </span>
                ) : row.reachable ? (
                  <span className="text-muted-foreground">Not reported</span>
                ) : (
                  cantTell
                )}
              </TableCell>
              <TableCell className="hidden tabular xl:table-cell">
                {row.memory ? (
                  <span className={DISK_TEXT[row.memory.tone]} title={`${formatBytes(row.memory.used)} of ${formatBytes(row.memory.total)} in use`}>
                    {row.memory.percent}% <span className="text-muted-foreground">used</span>
                  </span>
                ) : row.reachable ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  cantTell
                )}
              </TableCell>
              <TableCell className="hidden tabular xl:table-cell">
                {row.load ? (
                  <span className={DISK_TEXT[row.load.tone]} title={`1-minute load ${row.load.one.toFixed(2)} on ${row.load.cpus} CPU${row.load.cpus === 1 ? "" : "s"}`}>
                    {row.load.perCpu.toFixed(2)} <span className="text-muted-foreground">per CPU</span>
                  </span>
                ) : row.reachable ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  cantTell
                )}
              </TableCell>
              <TableCell className="text-right">
                <Button asChild variant="ghost" size="xs">
                  <Link href={`/servers/${row.id}`} aria-label={`Open ${row.name}`}>
                    Open
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}
