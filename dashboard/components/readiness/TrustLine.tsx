import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { StatusDot } from "@/components/status";
import { Card } from "@/components/ui/card";
import type { FleetServer } from "@/lib/fleet";
import { loadFleetReadiness } from "@/lib/readiness";
import { readinessHref, readinessSummary } from "@/lib/readiness-core";
import { READINESS } from "@/lib/status";

/**
 * Home's one line about trust: how many readiness checks of the whole fleet and of the dashboard pass, linking to the worst
 * place (the project's Readiness tab, the server, or the dashboard's settings). It does not list the checks: the attention
 * list above is about what is wrong now, this is about what has never been proven.
 */
export async function TrustLine({ servers, now }: { servers: FleetServer[]; now: number }) {
  const summary = readinessSummary(await loadFleetReadiness(servers, now));
  if (summary.total === 0) return null;
  const { worst } = summary;
  const tone = worst === null ? READINESS.ok.tone : READINESS[worst.state].tone;
  const body = (
    <Card className="flex-row flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors group-hover:border-foreground/25" data-testid="trust-line">
      <StatusDot tone={tone} />
      <strong className="font-semibold">{summary.text}</strong>
      {worst !== null && (
        <span className="min-w-0 break-words text-muted-foreground">
          · next: {worst.title}
          {worst.subject !== "" ? ` of ${worst.subject}` : ""}
          {worst.server && worst.scope !== "project" ? ` on ${worst.server.name}` : ""}
        </span>
      )}
      {worst !== null && <ChevronRightIcon aria-hidden className="ml-auto size-4 text-muted-foreground" />}
    </Card>
  );
  if (worst === null) return body;
  return (
    <Link href={readinessHref(worst)} className="group block rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      {body}
    </Link>
  );
}
