import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { LocalAddresses } from "@/components/projects/LocalAddresses";
import { VersionSentence } from "@/components/projects/VersionSentence";
import { StatusBadge, StatusDot } from "@/components/status";
import { Card } from "@/components/ui/card";
import { siteUrl, type ProjectView } from "@/lib/project-view-core";

/** The hairline over a card: the brand where all is well, the state's colour where it is not. */
const TOP = {
  success: "via-brand/50",
  warning: "via-warning/70",
  danger: "via-destructive/70",
  info: "via-info/60",
  muted: "via-border",
} as const;

/**
 * One project: its production address and whether it is up, the deployment that is going on or went last, and a chip for
 * each environment. The whole card opens the project; the address and the chips open the site and the environment.
 */
export function ProjectCard({ project }: { project: ProjectView }) {
  const { primary } = project;
  const { latest, state } = primary;
  // When the last deployment failed and the previous version still serves, the headline is what people get: the failed one is
  // named in the warning below, never as the version of the project.
  const servesOld = state.lastFailed && primary.serves && primary.serving !== null;
  return (
    <Card className="relative h-full gap-3.5 overflow-hidden py-5 transition-colors hover:border-foreground/25" data-testid="project-card">
      <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${TOP[state.tone]}`} />
      <div className="flex items-start justify-between gap-3 px-5">
        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate font-display text-lg font-semibold tracking-tight">
            <Link href={project.href} className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {project.name}
            </Link>
          </h3>
          {project.repo !== null && <p className="truncate font-mono text-xs text-muted-foreground">{project.repo}</p>}
        </div>
        <StatusBadge view={state} />
      </div>

      <p className="flex min-w-0 items-center gap-1.5 px-5 text-sm">
        <span className="shrink-0 text-muted-foreground capitalize">{primary.name}</span>
        {primary.domain !== null && (
          <a href={siteUrl(primary.domain)} target="_blank" rel="noopener noreferrer" className="relative z-10 flex min-w-0 items-center gap-1 font-medium underline-offset-4 hover:underline">
            <span className="truncate">{primary.domain}</span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">(opens the site)</span>
          </a>
        )}
      </p>
      {primary.domain === null && primary.localAddresses.length > 0 && (
        <div className="px-5">
          <LocalAddresses addresses={primary.localAddresses} serverName={primary.servers[0].name} className="relative z-10" />
        </div>
      )}

      <div className="min-w-0 space-y-1.5 px-5">
        {servesOld && primary.serving ? (
          <VersionSentence version={primary.serving} deployment={primary.deployed} />
        ) : latest ? (
          <VersionSentence version={latest.ref} deployment={latest} />
        ) : (
          <p className="text-sm text-muted-foreground">Nothing deployed yet.</p>
        )}
        {state.lastFailed && (
          <p className="flex items-center gap-1.5 text-xs text-warning-text">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            <span>
              The last deployment{latest ? <> (<span className="font-mono">{latest.ref.sha ?? latest.ref.version}</span>)</> : null} failed.{" "}
              {primary.serves && primary.serving ? <>Still serving <span className="font-mono">{primary.serving.version}</span>.</> : "Nothing is running."}
            </span>
          </p>
        )}
        {state.label === "Down" && state.detail !== undefined && <p className="text-xs text-destructive-text">{state.detail}</p>}
      </div>

      <ul className="mt-auto flex flex-wrap items-center gap-y-1.5 border-t px-5 pt-3.5" aria-label="Environments">
        {project.environments.map((e, i) => (
          <li key={e.name} className="flex items-center">
            {i > 0 && <span aria-hidden className="mx-2 h-px w-4 bg-border" />}
            <Link
              href={e.href}
              title={`${e.name}: ${e.state.label}`}
              className="relative z-10 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium capitalize text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StatusDot tone={e.state.tone} live={e.state.live} />
              {e.name}
              <span className="sr-only"> {e.state.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The projects as cards in a responsive grid: the same on Home and on the Projects page. */
export function ProjectGrid({ projects }: { projects: ProjectView[] }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="projects">
      {projects.map((p) => (
        <li key={p.name} className="min-w-0">
          <ProjectCard project={p} />
        </li>
      ))}
    </ul>
  );
}
