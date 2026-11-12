"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DefaultCard } from "@/components/notifications/DefaultCard";
import { DefaultDialog } from "@/components/notifications/DefaultDialog";
import { ApplyDialog } from "@/components/notifications/ApplyDialog";
import { TestAllDialog } from "@/components/notifications/TestAllDialog";
import { TestAlertDialog } from "@/components/readiness/TestAlertDialog";
import { RelativeTime } from "@/components/relative-time";
import { ResourceBody, ResourceCell, ResourceHead, ResourceHeadCell, ResourceRow, ResourceTable } from "@/components/resource-table";
import { EmptyState } from "@/components/states";
import { SegmentedControl } from "@/components/forms/fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INLINE_LINK } from "@/components/layout";
import { ICONS } from "@/lib/icons";
import { channelLabel, DIFFERENCE_LABEL, type NotificationsTemplate } from "@/lib/notifications-core";
import {
  countsByFilter,
  differingIds,
  FILTERS,
  noChannel,
  paginate,
  selectable,
  selectableIds,
  visibleRows,
  type Filter,
  type NotificationsRow,
} from "@/lib/notifications-fleet-core";
import { notificationsHref } from "@/lib/redirects-core";
import { cn } from "@/lib/utils";

function Channels({ row }: { row: NotificationsRow }) {
  if (!row.read || row.channels === undefined) return <span className="text-muted-foreground">Can&apos;t tell</span>;
  if (noChannel(row)) {
    return (
      <div className="space-y-1">
        <Badge variant="warning">None</Badge>
        {row.channels.heartbeat && <p className="text-xs text-muted-foreground">Heartbeat only</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <span>{channelLabel(row.channels)}</span>
      {row.channels.heartbeat && <p className="text-xs text-muted-foreground">+ heartbeat</p>}
    </div>
  );
}

function Thresholds({ row }: { row: NotificationsRow }) {
  if (!row.read) return <span className="text-muted-foreground">–</span>;
  const parts = [...(row.disk === undefined ? [] : [`Disk ${row.disk}%`]), ...(row.memory === undefined ? [] : [`Memory ${row.memory}%`])];
  return parts.length === 0 ? <span className="text-muted-foreground">Default</span> : <span className="tabular">{parts.join(" · ")}</span>;
}

function FollowsDefault({ row, hasDefault }: { row: NotificationsRow; hasDefault: boolean }) {
  if (!hasDefault || !row.read) return <span className="text-muted-foreground">–</span>;
  if (row.differs.length === 0) return <Badge variant="muted">Follows it</Badge>;
  return (
    <div className="space-y-1">
      <Badge variant="warning">Differs from the default</Badge>
      <p className="text-xs text-muted-foreground">{row.differs.map((d) => DIFFERENCE_LABEL[d]).join(", ")}</p>
    </div>
  );
}

function LastTest({ row }: { row: NotificationsRow }) {
  if (row.test.kind === "at") return <RelativeTime at={row.test.at} />;
  if (row.test.kind === "never") return noChannel(row) ? <span className="text-muted-foreground">–</span> : <span className="text-muted-foreground">Never tested</span>;
  return <span className="text-muted-foreground">–</span>;
}

/**
 * Settings > Notifications for a fleet: the default (a template), then one row per server with what its agent reports, the problems
 * first, searchable, filterable and paged. A row opens that server's own form; servers are chosen with the boxes and the default is
 * applied to them in one reviewed step. Nothing here is desired state: every change is a save on the agent.
 */
export function NotificationsFleet({ rows, template, templateUpdatedAt }: { rows: NotificationsRow[]; template: NotificationsTemplate | null; templateUpdatedAt: number | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<"default" | "apply" | null>(null);

  if (rows.length === 0) {
    return (
      <div data-testid="notifications-empty">
        <EmptyState
          bordered
          compact
          icon={ICONS.notification}
          title="No servers yet"
          action={
            <Button asChild size="sm">
              <Link href="/servers/new">Add a server</Link>
            </Button>
          }
        >
          Notifications are configured on each server once it is added.
        </EmptyState>
      </div>
    );
  }

  const counts = countsByFilter(rows);
  const visible = visibleRows(rows, filter, query);
  const shown = paginate(visible, page);
  const chosen = rows.filter((r) => selectable(r) && selected.has(r.id));
  const differing = differingIds(rows);
  const everything = selectableIds(rows);
  const read = rows.filter((r) => r.read);
  const pageIds = shown.items.filter(selectable).map((r) => r.id);
  const pageAllChosen = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const choose = (ids: readonly string[]) => setSelected(new Set(ids));
  const toggle = (id: string, on: boolean) => setSelected((s) => new Set(on ? [...s, id] : [...s].filter((x) => x !== id)));
  const togglePage = (on: boolean) => setSelected((s) => new Set(on ? [...s, ...pageIds] : [...s].filter((id) => !pageIds.includes(id))));

  return (
    <div className="space-y-6">
      <DefaultCard
        template={template}
        updatedAt={templateUpdatedAt}
        following={read.filter((r) => r.differs.length === 0).length}
        differing={read.filter((r) => r.differs.length > 0).length}
        onEdit={() => setDialog("default")}
      />

      <section aria-label="Servers" className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search servers by name"
              placeholder="Search servers"
              className="pl-8"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <SegmentedControl
            label="Show"
            value={filter}
            options={FILTERS.map((f) => ({ value: f.id, label: `${f.label} ${counts[f.id]}` }))}
            onChange={(v) => {
              setFilter(v as Filter);
              setPage(1);
            }}
          />
          <div className="ml-auto">
            <TestAllDialog rows={rows} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="selection-bar">
          <span className="tabular text-muted-foreground" aria-live="polite">
            {chosen.length} selected
          </span>
          <Button type="button" variant="outline" size="sm" disabled={differing.length === 0} onClick={() => choose(differing)}>
            All that differ ({differing.length})
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={everything.length === 0} onClick={() => choose(everything)}>
            All ({everything.length})
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={chosen.length === 0} onClick={() => choose([])}>
            Clear
          </Button>
          <Button type="button" className="ml-auto" disabled={template === null || chosen.length === 0} onClick={() => setDialog("apply")}>
            Apply the default to {chosen.length} {chosen.length === 1 ? "server" : "servers"}
          </Button>
        </div>

        <ResourceTable data-testid="notifications-table">
          <ResourceHead>
            <ResourceHeadCell className="w-10 pl-4">
              <input
                type="checkbox"
                aria-label="Select the servers on this page"
                className="size-4 accent-primary"
                checked={pageAllChosen}
                disabled={pageIds.length === 0}
                onChange={(e) => togglePage(e.target.checked)}
              />
            </ResourceHeadCell>
            <ResourceHeadCell>Server</ResourceHeadCell>
            <ResourceHeadCell>Channels</ResourceHeadCell>
            <ResourceHeadCell from="md">Events</ResourceHeadCell>
            <ResourceHeadCell from="lg">Thresholds</ResourceHeadCell>
            <ResourceHeadCell>Default</ResourceHeadCell>
            <ResourceHeadCell from="md">Last test</ResourceHeadCell>
            <ResourceHeadCell className="pr-4">
              <span className="sr-only">Actions</span>
            </ResourceHeadCell>
          </ResourceHead>
          <ResourceBody>
            {shown.items.length === 0 && (
              <tr className="max-sm:block">
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground max-sm:block">
                  No server matches{query.trim() === "" ? "" : ` “${query.trim()}”`}
                  {filter === "all" ? "." : ` in “${FILTERS.find((f) => f.id === filter)?.label}”.`}
                </td>
              </tr>
            )}
            {shown.items.map((row) => (
              <ResourceRow key={row.id} data-server={row.id} state={row.state} problem={row.state === "unreachable"}>
                <ResourceCell label="Select" className="w-10 pl-4">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    className="size-4 accent-primary"
                    checked={selected.has(row.id)}
                    disabled={!selectable(row)}
                    title={selectable(row) ? undefined : row.reason}
                    onChange={(e) => toggle(row.id, e.target.checked)}
                  />
                </ResourceCell>
                <ResourceCell className="max-w-64">
                  <Link href={notificationsHref(row.id)} className={cn(INLINE_LINK, "block min-w-0 truncate")}>
                    {row.name}
                  </Link>
                  {row.state !== "ok" && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Badge variant={row.state === "unreachable" ? "danger" : "muted"}>{row.state === "unreachable" ? "Unreachable" : "Read-only"}</Badge>
                      <span className="min-w-0 break-words">{row.reason}</span>
                    </p>
                  )}
                </ResourceCell>
                <ResourceCell label="Channels">
                  <Channels row={row} />
                </ResourceCell>
                <ResourceCell from="md" label="Events">
                  {row.events ? <span title={row.events.list.join(", ")}>{row.events.text}</span> : <span className="text-muted-foreground">–</span>}
                </ResourceCell>
                <ResourceCell from="lg" label="Thresholds">
                  <Thresholds row={row} />
                </ResourceCell>
                <ResourceCell label="Default">
                  <FollowsDefault row={row} hasDefault={template !== null} />
                </ResourceCell>
                <ResourceCell from="md" label="Last test">
                  <LastTest row={row} />
                </ResourceCell>
                <ResourceCell className="pr-4 sm:text-right">
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    {row.state === "ok" && row.channels !== undefined && !noChannel(row) && <TestAlertDialog serverId={row.id} serverName={row.name} canDeploy label="Test" />}
                    <Button asChild variant="ghost" size="xs">
                      <Link href={notificationsHref(row.id)} aria-label={`Edit the notifications of ${row.name}`}>
                        <ICONS.edit />
                        Edit
                      </Link>
                    </Button>
                  </div>
                </ResourceCell>
              </ResourceRow>
            ))}
          </ResourceBody>
        </ResourceTable>

        {shown.pages > 1 && (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3 text-sm" data-testid="pagination">
            <span className="tabular text-muted-foreground">
              {shown.from}–{shown.to} of {shown.total}
            </span>
            <span className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={shown.page === 1} onClick={() => setPage(shown.page - 1)}>
                Previous
              </Button>
              <span className="tabular text-muted-foreground">
                Page {shown.page} of {shown.pages}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={shown.page === shown.pages} onClick={() => setPage(shown.page + 1)}>
                Next
              </Button>
            </span>
          </nav>
        )}
      </section>

      {dialog === "default" && <DefaultDialog template={template} onClose={() => setDialog(null)} />}
      {dialog === "apply" && template !== null && (
        <ApplyDialog
          template={template}
          rows={chosen}
          onClose={(ran) => {
            setDialog(null);
            if (ran) choose([]);
          }}
        />
      )}
    </div>
  );
}
