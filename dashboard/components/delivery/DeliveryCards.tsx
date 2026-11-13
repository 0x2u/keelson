import { EYEBROW } from "@/components/signature";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { duration, failureBand, frequency, frequencyBand, leadTimeBand, percent, restoreBand, type Band, type FleetDelivery } from "@/lib/delivery-core";
import { cn } from "@/lib/utils";

const BAND_LABEL: Record<Band, string> = { elite: "Elite", high: "High", medium: "Medium", low: "Low", unknown: "Not measured" };
const BAND_BADGE: Record<Band, "success" | "info" | "warning" | "danger" | "muted"> = {
  elite: "success",
  high: "info",
  medium: "warning",
  low: "danger",
  unknown: "muted",
};

/** One of the four measures: what it is, the number, the band it falls in, and what the number is made of. */
function Measure({ label, value, band, detail }: { label: string; value: string; band: Band; detail: string }) {
  return (
    <Card className="gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className={EYEBROW}>{label}</p>
        <Badge variant={BAND_BADGE[band]}>{BAND_LABEL[band]}</Badge>
      </div>
      <p className={cn("tabular font-display text-3xl font-semibold tracking-tight", band === "unknown" && "text-muted-foreground")}>{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </Card>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The four numbers of DORA for the fleet, with the band each falls in. The bands are the published ones; what the
 * number is made of is said under it, because a figure nobody can trace is a figure nobody believes.
 */
export function DeliveryCards({ fleet }: { fleet: FleetDelivery }) {
  const d = fleet.deployments;
  const failed = d.total - d.succeeded;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Measure
        label="Deployment frequency"
        value={frequency(fleet.perDay)}
        band={frequencyBand(fleet.perDay)}
        detail={`${plural(d.succeeded, "successful deployment")} over ${plural(Math.round(fleet.days), "day")}, across ${plural(fleet.reporting, "server")}.`}
      />
      <Measure
        label="Lead time for changes"
        value={duration(fleet.leadTime.medianSeconds) ?? "—"}
        band={leadTimeBand(fleet.leadTime.medianSeconds)}
        detail={
          fleet.leadTime.deployments === 0
            ? "Commit to production, over the deployments whose commit time the dashboard or the deploy action sent. None of them did."
            : `Median from commit to serving, over ${plural(fleet.leadTime.deployments, "deployment")} (${percent(fleet.leadTime.covered)} of the successful ones). 90th percentile ${duration(fleet.leadTime.p90Seconds) ?? "—"}.`
        }
      />
      <Measure
        label="Change failure rate"
        value={percent(fleet.changeFailureRatio) ?? "—"}
        band={failureBand(fleet.changeFailureRatio)}
        detail={d.total === 0 ? "No deployment finished in this window." : `${plural(failed, "deployment")} of ${d.total} did not leave the new version serving (${d.rolledBack} rolled back, ${d.failed} failed, ${d.rollbackFailed} could not be restored).`}
      />
      <Measure
        label="Time to restore service"
        value={duration(fleet.restore.medianSeconds) ?? "—"}
        band={restoreBand(fleet.restore.medianSeconds)}
        detail={
          fleet.restore.incidents === 0
            ? "No app went down in this window."
            : `Median of ${plural(fleet.restore.incidents, "outage")}${fleet.restore.ongoing > 0 ? ` (${fleet.restore.ongoing} still going)` : ""}; the longest was ${duration(fleet.restore.longestSeconds) ?? "—"}.`
        }
      />
    </div>
  );
}
