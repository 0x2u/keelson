import Link from "next/link";
import type { Metadata } from "next";
import { DeliveryCards } from "@/components/delivery/DeliveryCards";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ICONS } from "@/lib/icons";
import { duration, frequency, isRange, percent, RANGES, type Range } from "@/lib/delivery-core";
import { loadDelivery } from "@/lib/delivery";
import { listServers } from "@/lib/servers";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Delivery" };

const RANGE_LABEL: Record<Range, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

export default async function DeliveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).range;
  const asked = Array.isArray(raw) ? raw[0] : raw;
  const range: Range = isRange(asked) ? asked : "30d";
  const servers = listServers();
  const feed = servers.length === 0 ? null : await loadDelivery(range);

  return (
    <>
      <PageHeader
        title="Delivery"
        description="How this fleet delivers: how often it deploys, how long a change takes to reach production, how often one does not hold, and how long an app takes to serve again. The numbers come from the agents, which record every deployment and every outage."
      />

      {feed === null ? (
        <Card className="py-0">
          <EmptyState
            icon={ICONS.server}
            title="No servers yet"
            action={
              <Button asChild size="sm">
                <Link href="/servers/new">Add a server</Link>
              </Button>
            }
          >
            Deployments are recorded by a server&apos;s agent. Add a server to start measuring.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <nav aria-label="Window" className="flex flex-wrap gap-2">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={r === "30d" ? "/delivery" : `/delivery?range=${r}`}
                aria-current={r === range ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  r === range ? "border-foreground/30 bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {RANGE_LABEL[r]}
              </Link>
            ))}
          </nav>

          {feed.reports
            .filter((r) => r.problem !== undefined)
            .map((r) => (
              <Notice key={r.server.id} tone="warning" title={`${r.server.name} is not counted`}>
                {r.problem}
              </Notice>
            ))}

          <DeliveryCards fleet={feed.fleet} />

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Per server</h2>
            <Card className="overflow-x-auto py-0">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Server
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Deployments
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Frequency
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Lead time
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Failure rate
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Restore
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {feed.reports.map((r) => (
                    <tr key={r.server.id}>
                      <th scope="row" className="px-4 py-3 text-left font-medium">
                        <Link href={`/servers/${r.server.id}`} className="underline-offset-4 hover:underline">
                          {r.server.name}
                        </Link>
                      </th>
                      {r.delivery === null ? (
                        <td colSpan={5} className="px-4 py-3 text-muted-foreground">
                          {r.problem ?? "no answer"}
                        </td>
                      ) : (
                        <>
                          <td className="tabular px-4 py-3">
                            {r.delivery.deployments.succeeded} / {r.delivery.deployments.total}
                          </td>
                          <td className="tabular px-4 py-3">{frequency(r.delivery.per_day)}</td>
                          <td className="tabular px-4 py-3">{duration(r.delivery.lead_time.median_seconds) ?? "—"}</td>
                          <td className="tabular px-4 py-3">{percent(r.delivery.change_failure_ratio) ?? "—"}</td>
                          <td className="tabular px-4 py-3">{duration(r.delivery.restore.median_seconds) ?? "—"}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          <p className="text-xs text-muted-foreground">
            Deployments and outages are what each agent recorded, over {RANGE_LABEL[range].toLowerCase()}; an outage is an app its watcher saw down. The lead time needs the time of the commit, which the
            dashboard sends when it builds from a repository and the deploy action sends from a workflow; a deployment without it is not counted in that figure. The same numbers are on each agent&apos;s{" "}
            <code>/metrics</code> for Prometheus.
          </p>
        </div>
      )}
    </>
  );
}
