import { ICONS } from "@/lib/icons";
import type { AppAvailability } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { AVAILABILITY_RANGES, SHOWN_INCIDENTS, availabilityRangeLabel, availabilityView, formatIncident, type AvailabilityRange } from "@/lib/availability-core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FormCard } from "@/components/layout";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { RangeNav } from "@/components/StatsHistory";

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** How long the app was up over the last day, week or month, and when it was not, as the server judged it. */
export async function AvailabilityCard({ href, range, availability }: { href: (r: AvailabilityRange) => string; range: AvailabilityRange; availability: Promise<Loaded<AppAvailability | null>> }) {
  const result = await availability;

  let body;
  if (result.error !== undefined) {
    body = <Notice title="The availability could not be read">{result.error}</Notice>;
  } else if (result.data === null) {
    body = (
      <EmptyState icon={ICONS.history} title="No availability yet">
        A server records it once it is set up for deployments and runs a recent version of Keelson.
      </EmptyState>
    );
  } else {
    const a = result.data;
    const view = availabilityView(a);
    if (view.kind === "none") {
      body = (
        <EmptyState icon={ICONS.history} title="No availability yet">
          The server records it from the first time it sees this app running. Deploy a version, then come back.
        </EmptyState>
      );
    } else if (view.kind === "just-started") {
      body = (
        <p className="text-sm text-muted-foreground">
          The server started watching this app <RelativeTime at={view.since} />: there is nothing to average yet.
        </p>
      );
    } else {
      const shown = a.incidents.slice(0, SHOWN_INCIDENTS);
      body = (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={cn("text-3xl font-semibold tabular", view.down && "text-warning-text")}>{view.uptime}</span>
            <span className="text-sm text-muted-foreground">
              up {view.partial ? <>since {absolute.format(new Date(view.since))} UTC, when the server started watching</> : <>over the last {availabilityRangeLabel(range)}</>}
            </span>
            {view.ongoing && <Badge variant="danger">Down now</Badge>}
          </div>
          {view.partial && <p className="text-xs text-muted-foreground">The server has watched this app for less than {availabilityRangeLabel(range)}: the percentage covers only the part it saw.</p>}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No incident in this period.</p>
          ) : (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Last incidents</h3>
              <ul className="divide-y rounded-md border text-sm">
                {shown.map((i) => (
                  <li key={i.start} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                    <span>
                      Down <RelativeTime at={i.start} />
                    </span>
                    <span className="tabular text-muted-foreground">
                      {i.end === null ? `still down after ${formatIncident(i.duration_seconds)}` : `back after ${formatIncident(i.duration_seconds)}`}
                    </span>
                  </li>
                ))}
              </ul>
              {a.incidents.length > shown.length && <p className="text-xs text-muted-foreground">And {a.incidents.length - shown.length} earlier in this period.</p>}
            </div>
          )}
        </>
      );
    }
  }

  return (
    <FormCard
      title="Availability"
      description="An app counts as down after three failed checks in a row, 15 seconds apart. Time spent deploying does not count."
      action={<RangeNav label="Availability range" href={href} range={range} ranges={AVAILABILITY_RANGES} />}
    >
      {body}
    </FormCard>
  );
}

/** Placeholder with the card's geometry. */
export function AvailabilitySkeleton() {
  return (
    <Card aria-hidden>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}
