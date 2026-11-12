import { filterHref, parseFilter } from "@/lib/activity-core";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import Link from "next/link";
import type { ReactNode } from "react";
import { DatabasesTable } from "@/components/databases/DatabasesTable";
import { JobsTable } from "@/components/jobs/JobsTable";
import { CantTell, UnansweredNotice } from "@/components/fleet/Unreachable";
import { FleetHero } from "@/components/home/FleetHero";
import { ServerGauges } from "@/components/home/ServerResources";
import { EYEBROW } from "@/components/signature";
import { ProjectGrid } from "@/components/projects/ProjectCard";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, Notice } from "@/components/states";
import { DeploymentBadge, JobBadge, ServerStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { attentionItems, itemsOf, summarize, type AttentionItem } from "@/lib/attention-core";
import type { DatabaseStatus } from "@/lib/agent-types";
import { dayBuckets, fleetFigures, headline, recentEvents, type HomeServer, type RecentEvent } from "@/lib/home-core";
import type { ProjectView } from "@/lib/project-view-core";
import type { ServerSnapshot } from "@/lib/attention-core";
import { cn } from "@/lib/utils";

export interface HomeServerData extends HomeServer, ServerSnapshot {
  url: string;
  version?: string;
  readOnly?: boolean;
  databases?: DatabaseStatus[] | null;
}

const EDGE = { critical: "border-l-destructive", warning: "border-l-warning", info: "border-l-info" } as const;
const SEVERITY_ICON = { critical: CircleAlertIcon, warning: TriangleAlertIcon, info: InfoIcon } as const;
const SEVERITY_TEXT = { critical: "text-destructive-text", warning: "text-warning-text", info: "text-info-text" } as const;
const SEVERITY_LABEL = { critical: "Critical", warning: "Warning", info: "Info" } as const;

const linkClass = "font-medium underline-offset-4 hover:underline";

/** The activity feed over the last day: what the "Last 24 h" section summarises. */
const DAY = parseFilter({ window: "24h" });

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className={EYEBROW}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One thing that needs a look: severity, what is wrong and why, where, since when, and the ways to look into it. */
export function AttentionRow({ item, showServer = true }: { item: AttentionItem; showServer?: boolean }) {
  const Icon = SEVERITY_ICON[item.severity];
  return (
    <li className={cn("flex flex-col gap-2 border-l-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4", EDGE[item.severity])}>
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-start gap-2 text-sm">
          <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", SEVERITY_TEXT[item.severity])} />
          <span className="min-w-0 break-words">
            <span className="sr-only">{SEVERITY_LABEL[item.severity]}: </span>
            {item.message}
          </span>
        </p>
        {(showServer || item.since) && (
          <p className="pl-6 text-xs text-muted-foreground">
            {showServer && item.server.name}
            {item.since && (
              <>
                {showServer && " · "}
                <RelativeTime at={item.since} />
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 pl-6 sm:pl-0">
        {item.actions.map((a) => (
          <Button key={`${a.label}${a.href}`} asChild variant="outline" size="xs">
            <Link href={a.href}>{a.label}</Link>
          </Button>
        ))}
      </div>
    </li>
  );
}

function RecentRow({ e }: { e: RecentEvent }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5">
      <div className="min-w-0">
        <Link href={e.href} className={cn(linkClass, "block truncate text-sm")}>
          {e.kind === "job" ? `Job ${e.subject}` : e.subject}
        </Link>
        <p className="truncate text-xs text-muted-foreground" title={e.detail}>
          {e.server.name}
          {e.detail && <> · {e.detail.split("\n").find((l) => l.trim()) ?? ""}</>}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {e.kind === "deployment" ? <DeploymentBadge status={e.status} trigger={e.trigger} image={e.image} /> : <JobBadge status={e.status} />}
        <RelativeTime at={e.at} className="text-xs text-muted-foreground" />
      </div>
    </li>
  );
}

function ServersStrip({ servers, items }: { servers: HomeServerData[]; items: AttentionItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((s) => {
        const verdict = summarize(itemsOf(items, s.server.id));
        return (
          <li key={s.server.id}>
            <Link href={`/servers/${s.server.id}`} className="block rounded-2xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              <Card className="gap-4 p-4 transition-colors hover:border-foreground/25">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block truncate font-display text-sm font-semibold tracking-tight">{s.server.name}</span>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.reachable ? (
                        <>
                          agent {s.version}
                          {s.readOnly ? " · read-only" : ""}
                        </>
                      ) : (
                        (s.reason ?? "no answer")
                      )}
                    </p>
                  </div>
                  <ServerStatusBadge reachable={s.reachable} attention={verdict} />
                </div>
                {s.reachable && <ServerGauges system={s.system} />}
              </Card>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The home page: is everything fine, and if not what; then the projects, the databases, the last day, the servers. Every
 * section that lists data of servers says so when a server did not answer, instead of looking empty.
 */
export function HomeView({
  servers,
  projects,
  now,
  generatedAt,
  needsSecondFactor,
  backupSize,
  trust,
}: {
  servers: HomeServerData[];
  projects: ProjectView[];
  now: number;
  generatedAt: number;
  needsSecondFactor: boolean;
  /** The size of a database's last backup, loaded apart because it is read from the backup destination. */
  backupSize?: (serverId: string, database: string) => ReactNode;
  /** The one line about trust (readiness), loaded apart because it asks every agent for its proofs. */
  trust?: ReactNode;
}) {
  const items = attentionItems(servers, now);
  const head = headline(items, servers);
  const unanswered = servers.filter((s) => !s.reachable).map((s) => ({ id: s.server.id, name: s.server.name, reason: s.reason }));
  const events = recentEvents(servers, now);
  const figures = fleetFigures(servers, now);
  const secondFactorNotice = needsSecondFactor ? (
    <Notice
      tone="warning"
      title="Add a second factor"
      action={
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href="/settings/security">Open security settings</Link>
        </Button>
      }
    >
      This dashboard can deploy to and read logs from every server, so a password alone is a weak lock. Add an authenticator app or a passkey.
    </Notice>
  ) : null;

  return (
    <>
      <PageHeader
        title="Home"
        actions={
          <>
            <LiveRefresh generatedAt={generatedAt} />
            {servers.length > 0 && (
              <Button asChild>
                <Link href="/projects/new">
                  <ICONS.add /> New project
                </Link>
              </Button>
            )}
            <Button asChild variant={servers.length > 0 ? "outline" : "default"}>
              <Link href="/servers/new">
                <ICONS.add /> Add server
              </Link>
            </Button>
          </>
        }
      />
      {servers.length === 0 && secondFactorNotice && <div className="mb-6">{secondFactorNotice}</div>}
      {servers.length === 0 ? (
        <Card>
          <EmptyState
            icon={ICONS.server}
            title="No servers yet"
            action={
              <Button asChild size="sm">
                <Link href="/servers/new">Add your first server</Link>
              </Button>
            }
          >
            Run one command on a server: its Keelson agent installs itself and connects out to this dashboard.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-9">
          <FleetHero head={head} figures={figures} buckets={dayBuckets(recentEvents(servers, now, 500), now)} />

          {items.length > 0 && (
            <Section id="attention" title="Needs attention">
              <Card className="gap-0 overflow-hidden py-0">
                <ul className="divide-y" data-testid="attention">
                  {items.map((item) => (
                    <AttentionRow key={item.id} item={item} />
                  ))}
                </ul>
              </Card>
            </Section>
          )}

          {trust}

          {secondFactorNotice}

          <Section
            id="projects"
            title="Projects"
            action={
              <Link href="/projects" className={cn(linkClass, "text-sm")}>
                All projects
              </Link>
            }
          >
            {projects.length === 0 ? (
              <Card>
                {unanswered.length > 0 ? (
                  <CantTell servers={unanswered} what="Projects" />
                ) : (
                  <EmptyState
                    icon={ICONS.project}
                    title="No projects yet"
                    action={
                      <Button asChild>
                        <Link href="/projects/new">
                          <ICONS.add /> New project
                        </Link>
                      </Button>
                    }
                  >
                    A project is what you ship: its apps, jobs and databases, on one server or several.
                  </EmptyState>
                )}
              </Card>
            ) : (
              <>
                <UnansweredNotice servers={unanswered} what="Apps" />
                <ProjectGrid projects={projects} />
              </>
            )}
          </Section>

          <Section
            id="jobs"
            title="Jobs"
            action={
              <Link href="/jobs" className={cn(linkClass, "text-sm")}>
                All jobs
              </Link>
            }
          >
            <JobsTable
              scope="fleet"
              entries={servers.flatMap((s) => (s.reachable ? (s.jobs ?? []).map((job) => ({ server: { ...s.server, canDeploy: s.canDeploy }, job, ...(job.project ? { project: job.project } : {}) })) : []))}
              unanswered={unanswered}
              servers={servers.map((s) => ({ ...s.server, canDeploy: s.canDeploy }))}
              from="/jobs"
              now={now}
            />
          </Section>

          <Section
            id="databases"
            title="Databases"
            action={
              <Link href="/databases" className={cn(linkClass, "text-sm")}>
                All databases
              </Link>
            }
          >
            <DatabasesTable
              scope="fleet"
              entries={servers.flatMap((s) =>
                s.reachable ? (s.databases ?? []).map((db) => ({ server: { ...s.server, canDeploy: s.canDeploy }, db, ...(db.project ? { project: db.project } : {}) })) : [],
              )}
              unanswered={unanswered}
              servers={servers.map((s) => ({ ...s.server, canDeploy: s.canDeploy }))}
              from="/databases"
              now={now}
              backupSize={backupSize}
            />
          </Section>

          <Section
            id="recent"
            title="Last 24 h"
            action={
              <span className="flex items-center gap-4">
                <Link href={filterHref(DAY, { failed: true })} className={cn(linkClass, "text-sm")}>
                  Failures only
                </Link>
                <Link href={filterHref(DAY)} className={cn(linkClass, "text-sm")}>
                  All activity
                </Link>
              </span>
            }
          >
            {events.length === 0 ? (
              <Card>
                {unanswered.length > 0 ? (
                  <CantTell servers={unanswered} what="Recent deployments and job runs" />
                ) : (
                  <EmptyState icon={ICONS.activity} title="Nothing in the last 24 hours">
                    Deployments and failed job runs of the last day show up here.
                  </EmptyState>
                )}
              </Card>
            ) : (
              <>
                <UnansweredNotice servers={unanswered} what="Deployments and job runs" />
                <Card className="gap-0 overflow-hidden py-0">
                  <ul className="divide-y" data-testid="recent">
                    {events.map((e) => (
                      <RecentRow key={e.id} e={e} />
                    ))}
                  </ul>
                </Card>
              </>
            )}
          </Section>

          <Section id="servers" title="Servers">
            <ServersStrip servers={servers} items={items} />
          </Section>
        </div>
      )}
    </>
  );
}

