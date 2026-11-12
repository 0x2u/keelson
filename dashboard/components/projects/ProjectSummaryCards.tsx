import Link from "next/link";
import { StatusDot } from "@/components/status";
import { EYEBROW } from "@/components/signature";
import { Card } from "@/components/ui/card";
import type { HubSummary } from "@/lib/project-hub-core";
import type { ProjectTabId } from "@/lib/nav-core";
import type { Tone } from "@/lib/status";

interface CardView {
  id: ProjectTabId;
  title: string;
  count: number;
  tone: Tone;
  line: string;
  /** What the card is, said when it is empty. */
  empty: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The four cards of the overview, in the order of the tabs: what the project has, and whether it is fine. */
export function summaryCards(s: HubSummary, unanswered: boolean): CardView[] {
  const unknown = unanswered ? " (a server did not answer: there may be more)" : "";
  const list = (parts: (string | false)[]): string => parts.filter(Boolean).join(", ");
  const jobsLine = list([s.jobs.failing > 0 && `${s.jobs.failing} failing`, s.jobs.neverRun > 0 && `${s.jobs.neverRun} never run`, s.jobs.paused > 0 && `${s.jobs.paused} paused`]);
  const dbLine = list([
    s.databases.failed > 0 && `${s.databases.failed} with a failed backup`,
    s.databases.overdue > 0 && `${s.databases.overdue} overdue or never scheduled`,
    s.databases.unprotected > 0 && `${s.databases.unprotected} without a running backup schedule`,
    s.databases.pending > 0 && `${s.databases.pending} waiting for the first backup`,
  ]);
  const dbUrgent = s.databases.failed + s.databases.overdue > 0;
  return [
    {
      id: "apps",
      title: "Apps",
      count: s.apps.count,
      tone: s.apps.down > 0 ? "danger" : s.apps.count === 0 ? "muted" : "success",
      line: s.apps.down > 0 ? `${s.apps.down} down` : s.apps.count === 0 ? "No app yet" : "All up",
      empty: "The apps of this project.",
    },
    {
      id: "jobs",
      title: "Jobs",
      count: s.jobs.count,
      tone: s.jobs.failing > 0 ? "danger" : s.jobs.neverRun > 0 ? "warning" : s.jobs.count === 0 || s.jobs.paused > 0 ? "muted" : "success",
      line: jobsLine || (s.jobs.count === 0 ? `No scheduled job${unknown}` : "All healthy"),
      empty: "Scheduled work that acts on the project's apps.",
    },
    {
      id: "databases",
      title: "Databases",
      count: s.databases.count,
      tone: dbUrgent ? "danger" : s.databases.look > 0 ? "warning" : s.databases.pending > 0 ? "info" : s.databases.count === 0 ? "muted" : "success",
      line: dbLine || (s.databases.count === 0 ? `No database${unknown}` : "Backed up"),
      empty: "Databases the apps use.",
    },
    {
      id: "domains",
      title: "Domains",
      count: s.domains.count,
      tone: s.domains.count === 0 ? "muted" : "success",
      line: s.domains.count === 0 ? "No public hostname" : plural(s.domains.count, "hostname"),
      empty: "Public hostnames of the project.",
    },
  ];
}

export function ProjectSummaryCards({ summary, hrefs, unanswered }: { summary: HubSummary; hrefs: Record<string, string>; unanswered: boolean }) {
  return (
    <section aria-label="Project at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {summaryCards(summary, unanswered).map((c) => (
        <Link key={c.id} href={hrefs[c.id]} className="rounded-2xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <Card className="h-full gap-2 px-5 py-4 transition-colors hover:border-foreground/25">
            <div className="flex items-start justify-between gap-2">
              <span className={EYEBROW}>{c.title}</span>
              <span className="tabular font-display text-3xl leading-none font-semibold tracking-tight">{c.count}</span>
            </div>
            <p className="flex items-center gap-2 text-sm">
              <StatusDot tone={c.tone} />
              <span>{c.line}</span>
            </p>
            {c.count === 0 && <p className="text-xs text-muted-foreground">{c.empty}</p>}
          </Card>
        </Link>
      ))}
    </section>
  );
}
