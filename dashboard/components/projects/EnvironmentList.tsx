import { ChevronRightIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { LocalAddresses } from "@/components/projects/LocalAddresses";
import { VersionSentence } from "@/components/projects/VersionSentence";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { TableCard } from "@/components/layout";
import { siteUrl, type EnvironmentView } from "@/lib/project-view-core";

/** The other environments of a project, one compact row each: where it is live, what version, its state, where it runs. */
export function EnvironmentList({ environments }: { environments: EnvironmentView[] }) {
  return (
    <TableCard>
      <ul className="divide-y" data-testid="environments">
        {environments.map((e) => (
          <li key={e.name} className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-accent/40 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_auto_1rem]">
            <div className="min-w-0 space-y-0.5">
              <Link href={e.href} className="block truncate text-sm font-medium capitalize outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring">
                {e.name}
              </Link>
              <p className="truncate text-xs text-muted-foreground">{e.servers.map((s) => s.name).join(", ")}</p>
            </div>
            <div className="md:order-4">
              <StatusBadge view={e.state} />
            </div>
            <div className="col-span-2 min-w-0 md:order-2 md:col-span-1">
              {e.domain !== null ? (
                <a href={siteUrl(e.domain)} target="_blank" rel="noopener noreferrer" className="relative z-10 inline-flex max-w-full items-center gap-1 text-sm underline-offset-4 hover:underline">
                  <span className="truncate">{e.domain}</span>
                  <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
                  <span className="sr-only">(opens the site)</span>
                </a>
              ) : e.localAddresses.length > 0 ? (
                <LocalAddresses addresses={e.localAddresses} serverName={e.servers[0].name} className="relative z-10" />
              ) : (
                <span className="text-sm text-muted-foreground">No public address known</span>
              )}
            </div>
            <div className="col-span-2 min-w-0 md:order-3 md:col-span-1">
              {e.serving ? (
                <VersionSentence version={e.serving} deployment={e.deployed} />
              ) : (
                <p className="text-sm text-muted-foreground">{e.latest === null ? "Not deployed yet" : "Nothing is running"}</p>
              )}
            </div>
            <ChevronRightIcon aria-hidden className="hidden size-4 text-muted-foreground md:order-5 md:block" />
            {(e.state.lastFailed || e.variablesBehind) && (
              <ul className="order-last col-span-full flex flex-wrap gap-x-4 gap-y-1 text-xs text-warning-text">
                {e.state.lastFailed && e.latest !== null && (
                  <li className="flex items-center gap-1.5">
                    <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                    <span>
                      The last deployment failed <RelativeTime at={e.latest.startedAt} />.
                    </span>
                  </li>
                )}
                {e.variablesBehind && (
                  <li className="flex items-center gap-1.5">
                    <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                    Variables changed since this version was deployed.
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </TableCard>
  );
}
