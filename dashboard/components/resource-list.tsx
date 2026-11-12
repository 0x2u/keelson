import Link from "next/link";
import type { ReactNode } from "react";
import { AddTargetMenu } from "@/components/AddTargetMenu";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { INLINE_LINK, SegmentedNav } from "@/components/layout";
import { ICONS } from "@/lib/icons";
import { listHref, type AddTarget, type ListFilter, type ListKind } from "@/lib/resource-lists-core";
import type { ServerRef } from "@/lib/projects-core";
import { cn } from "@/lib/utils";

// What the jobs table and the databases table have in common around the rows: where to add one, the filter chips, and the
// collapsed list of what no project claims.

/**
 * "Add job" / "Add database": one button when there is one server to add it on, a menu that asks which server when there
 * are several. A read-only server's button is disabled and says why.
 */
export function AddAction({
  noun,
  targets,
  primary,
}: {
  noun: "job" | "database";
  targets: AddTarget[];
  /** The one next step of an empty list: the filled button; otherwise an outline one beside the summary. */
  primary?: boolean;
}) {
  const variant = primary ? "default" : "outline";
  const size = primary ? undefined : "sm";
  const label = `Add ${noun}`;
  if (targets.length === 0) return null;
  if (targets.length === 1) {
    const [only] = targets;
    return (
      <ConfigActionLink href={only.href} enabled={only.server.canDeploy} variant={variant} size={size}>
        <ICONS.add />
        {label}
      </ConfigActionLink>
    );
  }
  return (
    <AddTargetMenu
      label={label}
      variant={variant}
      size={size}
      items={targets.map((t) => ({ key: t.server.id, server: t.server.name, href: t.href, enabled: t.server.canDeploy }))}
    />
  );
}

/**
 * The `?server=` and `?project=` filter of a global list, as chips that are links (the state is in the address, so it can be
 * shared and survives a reload). A row of chips is only offered when there is something to choose between.
 */
export function ListFilters({ kind, filter, servers, projects }: { kind: ListKind; filter: ListFilter; servers: ServerRef[]; projects: string[] }) {
  const showServers = servers.length > 1 || filter.server !== undefined;
  const showProjects = projects.length > 0 || filter.project !== undefined;
  if (!showServers && !showProjects) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="list-filters">
      {showServers && (
        <ChipRow
          label="Server"
          items={[
            { key: "all", label: "All servers", href: listHref(kind, { ...filter, server: undefined }), current: filter.server === undefined },
            ...servers.map((s) => ({ key: s.id, label: s.name, href: listHref(kind, { ...filter, server: s.id }), current: filter.server === s.id })),
          ]}
        />
      )}
      {showProjects && (
        <ChipRow
          label="Project"
          items={[
            { key: "all", label: "All projects", href: listHref(kind, { ...filter, project: undefined }), current: filter.project === undefined },
            ...projects.map((p) => ({ key: p, label: p, href: listHref(kind, { ...filter, project: p }), current: filter.project === p })),
          ]}
        />
      )}
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items: { key: string; label: string; href: string; current: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SegmentedNav label={label} items={items} />
    </div>
  );
}

export interface UnassignedItem {
  key: string;
  name: string;
  /** The page of the item itself. */
  href: string;
  meta: ReactNode;
  /** Where else to look: the list narrowed to its server. */
  openHref: string;
  openLabel: string;
}

/** What no project claims on the servers of a project's list, collapsed under the table: never dropped, never mixed in. */
export function UnassignedDetails({ testId, items }: { testId: string; items: UnassignedItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-lg border bg-card" data-testid={testId}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Not assigned to a project on this server ({items.length})</summary>
      <ul className="divide-y border-t text-sm">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span>
              <Link href={item.href} className={INLINE_LINK}>
                {item.name}
              </Link>
              <span className="ml-2 text-xs text-muted-foreground">{item.meta}</span>
            </span>
            <Link href={item.openHref} className={cn(INLINE_LINK, "text-xs font-normal")}>
              {item.openLabel}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
