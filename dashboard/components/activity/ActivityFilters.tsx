"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { FEED_KIND_LABELS, KINDS, WINDOWS, filterHref, type ActivityFilter, type ActivityWindow, type FeedOptions } from "@/lib/activity-core";
import { cn } from "@/lib/utils";

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        active ? "border-foreground/30 bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

const selectClass =
  "h-8 max-w-full min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

const WINDOW_LABELS: Record<ActivityWindow, string> = { "1h": "1 h", "24h": "24 h", "7d": "7 d" };

/** The feed's filters. Every choice is a URL: a chip is a link, a select goes to one, so a filtered feed can be shared and reloaded. */
export function ActivityFilters({ filter, options }: { filter: ActivityFilter; options: FeedOptions }) {
  const router = useRouter();
  const scope = filter.project !== undefined ? `project:${filter.project}` : filter.app !== undefined ? `app:${filter.app}` : "";
  return (
    <div className="space-y-3" data-testid="activity-filters">
      <nav aria-label="Kind" className="flex flex-wrap gap-2">
        <Chip href={filterHref(filter, { kind: undefined })} active={filter.kind === undefined}>
          All
        </Chip>
        {KINDS.map((k) => (
          <Chip key={k} href={filterHref(filter, { kind: k })} active={filter.kind === k}>
            {FEED_KIND_LABELS[k]}
          </Chip>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Server
          <select
            className={selectClass}
            value={filter.server ?? ""}
            onChange={(e) => router.push(filterHref(filter, { server: e.target.value || undefined }), { scroll: false })}
          >
            <option value="">All servers</option>
            {options.servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Project or app
          <select
            className={selectClass}
            value={scope}
            onChange={(e) => {
              const [type, ...rest] = e.target.value.split(":");
              const name = rest.join(":");
              router.push(filterHref(filter, { project: type === "project" ? name : undefined, app: type === "app" ? name : undefined }), { scroll: false });
            }}
          >
            <option value="">All projects and apps</option>
            {options.projects.length > 0 && (
              <optgroup label="Projects">
                {options.projects.map((p) => (
                  <option key={p} value={`project:${p}`}>
                    {p}
                  </option>
                ))}
              </optgroup>
            )}
            {options.apps.length > 0 && (
              <optgroup label="Apps">
                {options.apps.map((a) => (
                  <option key={a} value={`app:${a}`}>
                    {a}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <nav aria-label="Time window" className="flex items-center gap-1.5">
          {(Object.keys(WINDOWS) as ActivityWindow[]).map((w) => (
            <Chip key={w} href={filterHref(filter, { window: w })} active={filter.window === w}>
              {WINDOW_LABELS[w]}
            </Chip>
          ))}
        </nav>
        <Chip href={filterHref(filter, { failed: !filter.failed })} active={filter.failed}>
          Failed only
        </Chip>
      </div>
    </div>
  );
}
