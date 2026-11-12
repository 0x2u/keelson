import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { PipelineLine } from "@/components/deployments/PipelineLine";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { DeploymentBadge } from "@/components/status";
import { TableCard } from "@/components/layout";
import { duration } from "@/lib/format";
import { appKey, describeDeployment, type DeploymentEntry, type ProjectContext } from "@/lib/project-view-core";

/**
 * The latest deployments of a project, newest first: what was deployed (the commit's
 * message, else its hash or tag), where, who started it, when and how long it took. A row opens its deployment.
 */
export function DeploymentFeed({ entries, context }: { entries: DeploymentEntry[]; context: ProjectContext }) {
  if (entries.length === 0) {
    return <EmptyState bordered title="No deployments yet">Deployments of this project, and the builds that precede them, are listed here.</EmptyState>;
  }
  return (
    <TableCard>
      <ul className="divide-y" data-testid="deployments">
        {entries.map((e) => {
          const d = describeDeployment(e.deployment, context.sources[appKey(e.server.id, e.app)], context.commits);
          const meta: ReactNode[] = [
            <span key="env" className="font-medium text-foreground capitalize">
              {e.environment}
            </span>,
            <span key="server">{e.server.name}</span>,
            ...(d.ref.message !== null && d.ref.sha !== null ? [<span key="sha" className="font-mono">{d.ref.sha}</span>] : []),
            <span key="how">{d.trigger}</span>,
            <RelativeTime key="when" at={d.startedAt} />,
            ...(d.finishedAt ? [<span key="took">{duration(d.startedAt, d.finishedAt)}</span>] : []),
          ];
          return (
            <li key={`${e.server.id}/${d.id}`} className="relative flex flex-col items-start gap-1.5 px-4 py-3 hover:bg-accent/40 sm:flex-row sm:gap-3">
              <div className="sm:pt-0.5">
                <DeploymentBadge status={d.status} trigger={d.triggerCode} image={d.image} />
              </div>
              <div className="w-full min-w-0 flex-1 space-y-0.5">
                <Link
                  href={`/servers/${e.server.id}/deployments/${d.id}`}
                  className={`block truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring ${d.ref.message === null ? "font-mono" : ""}`}
                >
                  {d.ref.message ?? d.ref.version}
                </Link>
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  {meta.map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span aria-hidden>·</span>}
                      {part}
                    </Fragment>
                  ))}
                </p>
                {d.error && <p className="truncate text-xs text-destructive-text">{d.error}</p>}
                {d.status !== "succeeded" && <PipelineLine deployment={{ status: d.status, trigger: d.triggerCode, phases: d.phases }} />}
              </div>
            </li>
          );
        })}
      </ul>
    </TableCard>
  );
}
