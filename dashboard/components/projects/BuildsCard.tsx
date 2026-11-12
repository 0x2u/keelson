import { InlineLink } from "@/components/layout";
import { RelativeTime } from "@/components/relative-time";
import { DeploymentBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appKey, describeDeployment, type BuildsInfo, type ProjectContext } from "@/lib/project-view-core";

/** Where the project is built, kept quiet: the app's own server, or the other server that builds it with its last builds there. */
export function BuildsCard({ builds, context, sourceHref }: { builds: BuildsInfo | null; context: ProjectContext; sourceHref: string | null }) {
  return (
    <Card data-testid="builds">
      <CardHeader>
        <CardTitle>Builds</CardTitle>
        <CardDescription>
          {builds === null ? (
            "Builds run on the server that runs the app."
          ) : (
            <>
              Builds run on <InlineLink href={`/servers/${builds.server.id}`}>{builds.server.name}</InlineLink>, then the image is sent to the server that runs the app.
            </>
          )}
          {sourceHref !== null && (
            <>
              {" "}
              <InlineLink href={sourceHref} className="underline hover:text-foreground">
                Change where it builds
              </InlineLink>
            </>
          )}
        </CardDescription>
      </CardHeader>
      {builds !== null && (
        <CardContent>
          {builds.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">No build yet.</p>
          ) : (
            <ul className="space-y-1">
              {builds.recent.map((build) => {
                const d = describeDeployment(build, context.sources[appKey(builds.server.id, builds.app)], context.commits);
                return (
                  <li key={d.id} className="flex min-w-0 items-center gap-2 text-xs">
                    <DeploymentBadge status={d.status} trigger={d.trigger} />
                    <InlineLink href={`/servers/${builds.server.id}/deployments/${d.id}`} className="min-w-0 truncate font-normal" title={d.ref.message ?? d.ref.version}>
                      {d.ref.message ?? d.ref.version}
                    </InlineLink>
                    <RelativeTime at={d.startedAt} className="shrink-0 text-muted-foreground" />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
