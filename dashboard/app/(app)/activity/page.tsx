import { BellIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import type { Metadata } from "next";
import { ActivityFilters } from "@/components/activity/ActivityFilters";
import { ActivityRow, UnansweredRow } from "@/components/activity/ActivityRow";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PAGE_SIZE, filterHref, parseFilter } from "@/lib/activity-core";
import { loadActivity } from "@/lib/activity";
import { listServers } from "@/lib/servers";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filter = parseFilter(await searchParams);
  const generatedAt = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  const serverCount = listServers().length;
  const feed = await loadActivity(filter);
  const filtered = filter.kind !== undefined || filter.server !== undefined || filter.project !== undefined || filter.app !== undefined || filter.failed;
  const rows = feed.events.length + feed.unanswered.length;

  return (
    <>
      <PageHeader
        title="Activity"
        description="Deployments, job runs, backups, alerts, configuration changes and security events across your servers, newest first."
        actions={<LiveRefresh generatedAt={generatedAt} />}
      />

      <div className="space-y-4">
        {serverCount > 0 && <ActivityFilters filter={filter} options={feed.options} />}

        {feed.gaps.map((g) => (
          <Notice key={`${g.server.id}:${g.source}`} tone="warning" title={`Part of ${g.server.name}'s history is missing`}>
            The {g.source} of {g.server.name} could not be read ({g.reason}), so what it holds is not listed below.
          </Notice>
        ))}

        <Card className="gap-0 overflow-hidden py-0">
          {serverCount === 0 ? (
            <EmptyState
              icon={ICONS.server}
              title="No servers yet"
              action={
                <Button asChild size="sm">
                  <Link href="/servers/new">Add a server</Link>
                </Button>
              }
            >
              Deployments are recorded by a server&apos;s agent. Add a server to start seeing them here.
            </EmptyState>
          ) : rows === 0 ? (
            <EmptyState
              icon={ICONS.activity}
              title={filtered ? "Nothing matches these filters" : "Nothing happened in this period"}
              action={
                filtered || filter.window !== "7d" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={filterHref(filter, { kind: undefined, server: undefined, project: undefined, app: undefined, failed: false, window: "7d" })}>Clear the filters</Link>
                  </Button>
                ) : undefined
              }
            >
              {filtered ? "Try another kind, server or period." : "Deployments, job runs, alerts and changes from the dashboard, the GitHub Action or the API show up here."}
            </EmptyState>
          ) : (
            <ul className="divide-y" data-testid="activity">
              {feed.unanswered.map((s) => (
                <UnansweredRow key={s.id} server={s} />
              ))}
              {feed.events.map((e) => (
                <ActivityRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </Card>

        {feed.events.length > 0 && (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs text-muted-foreground" data-testid="activity-count">
              Showing {feed.events.length} of {feed.total}
              {feed.capped ? `. This is the most the list shows: narrow it down (a shorter period, one server or kind) to reach older events.` : "."}
            </p>
            {feed.more && (
              <Button asChild variant="outline">
                <Link href={filterHref(filter, { limit: filter.limit + PAGE_SIZE })} scroll={false}>
                  Load more
                </Link>
              </Button>
            )}
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="activity-alerts-note">
          <BellIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Alerts are the last 200 notifications each server raised, with how their delivery ended; a server running an older agent lists none. What needs attention now is on{" "}
            <Link href="/" className="underline underline-offset-4">
              Home
            </Link>
            .
          </span>
        </p>
      </div>
    </>
  );
}
