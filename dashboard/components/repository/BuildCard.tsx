import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { BuildForm } from "@/components/repository/BuildForm";
import { BuildServerForm } from "@/components/repository/BuildServerForm";
import type { SourceContext } from "@/lib/app-source";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, Notice } from "@/components/states";
import { DeliveryBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BuildConfig } from "@/lib/agent-types";
import { describeBuild } from "@/lib/presets-core";
import { recentBuildDeliveries } from "@/lib/webhook-deliveries";

/** What the agent says when the app has nothing to build from: shown on its own, not only in the table. */
const CANNOT_BUILD = "the agent cannot build this";

/** Builds by the GitHub App for a linked app: the switches, and what its latest pushes and pull requests did. */
export function BuildCard({
  serverId,
  app,
  appConfigured,
  appSlug,
  onPush,
  previews,
  secretSet,
  canDeploy,
  build,
  buildOn,
  where,
}: {
  serverId: string;
  app: string;
  appConfigured: boolean;
  appSlug: string | null;
  onPush: boolean;
  previews: boolean;
  secretSet: boolean;
  canDeploy: boolean;
  /** The app's `build:` block, for the line that says how it is built. */
  build?: BuildConfig;
  /** The id of the server that builds it when that is not where it runs. */
  buildOn?: string | null;
  /** What it takes to choose where it is built: this server and the others, with their numbers and limits. */
  where?: SourceContext["where"];
}) {
  const deliveries = recentBuildDeliveries(serverId, app, 10);
  const how = describeBuild(build);
  const refused = deliveries.find((d) => d.outcome === "failed" && d.detail.startsWith(CANNOT_BUILD));
  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub App build</CardTitle>
        <CardDescription>
          With the GitHub App installed on the repository, a push to the linked branch makes {app}&apos;s agent download the commit, build it with Docker and deploy
          it, with no CI workflow. A pull request from a branch of the same repository (never a fork) is built into the preview{" "}
          <span className="font-mono">{app}-pr-&lt;number&gt;</span>, which needs a <span className="font-mono">previews:</span> template on the agent. The app needs a{" "}
          <span className="font-mono">build:</span> block in the server&apos;s configuration. It works beside Automatic deploys: a commit is never deployed twice. A build runs the
          repository&apos;s Dockerfile, or the one the app&apos;s framework preset generates, on this server (or on the server chosen under Build on) and gets no secrets (only the variables marked for build time, which end up in the image and are never secret; a build on another server uses only the build arguments of the <span className="font-mono">build:</span> block). The commit shows a <span className="font-mono">keelson/build</span> status, and a pull request the
          preview&apos;s status, as the App.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-0">
        <div className="grid gap-4 px-6">
          {how && (
            <p className="text-sm" data-testid="build-summary">
              <span className="text-muted-foreground">Built with</span> <strong>{how.label}</strong>
              {how.details.length > 0 && <span className="text-muted-foreground"> · {how.details.join(" · ")}</span>}
            </p>
          )}
          {!appConfigured && (
            <Notice
              tone="warning"
              title="The GitHub App is not set up"
              action={
                <Link href="/settings/integrations" className="text-sm font-medium underline underline-offset-4">
                  Set it up in Integrations
                </Link>
              }
            >
              Builds can be turned on only once the App&apos;s credentials are saved.
            </Notice>
          )}
          {appConfigured && !secretSet && (
            <Notice
              tone="warning"
              title="The GitHub webhook is not set up"
              action={
                <Link href="/settings/integrations" className="text-sm font-medium underline underline-offset-4">
                  Set it up in Integrations
                </Link>
              }
            >
              Until a webhook secret exists, this dashboard refuses the App&apos;s deliveries and nothing builds.
            </Notice>
          )}
          {appConfigured && appSlug && (
            <p className="text-xs text-muted-foreground">
              The App must be installed on the repository:{" "}
              <a href={`https://github.com/apps/${appSlug}/installations/new`} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                install {appSlug}
              </a>
              .
            </p>
          )}
          {!canDeploy && (
            <Notice tone="warning" title="This server cannot deploy from here">
              Its deploy access is not in the dashboard, so every build request would fail. Add it in the server settings.
            </Notice>
          )}
          {refused && (
            <Notice tone="warning" title="This app cannot be built on its agent">
              {refused.detail}. Add a <span className="font-mono">build:</span> block to the app in the server&apos;s configuration (and a <span className="font-mono">previews:</span> template
              for pull requests).
            </Notice>
          )}
          <BuildForm serverId={serverId} app={app} appConfigured={appConfigured} onPush={onPush} previews={previews} />
          {where !== undefined && (where.choices.length > 0 || buildOn) && (
            <BuildServerForm
              serverId={serverId}
              app={app}
              current={buildOn ?? null}
              ownName={where.ownName}
              ownStats={where.ownStats}
              ownMemory={build?.memory}
              choices={where.choices}
              notSent={where.notSent}
              buildVars={where.buildVars}
            />
          )}
        </div>

        <div className="min-w-0">
          <h3 className="px-6 pb-2 text-sm font-medium">Latest builds</h3>
          {deliveries.length === 0 ? (
            <EmptyState icon={ICONS.build} title="Nothing received yet">
              Builds appear here once GitHub reports a push to the linked branch, or a pull request, through the App.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">When</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="pr-6">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((d) => (
                    <TableRow key={`${d.deliveryId}/${d.app}`}>
                      <TableCell className="pl-6 text-muted-foreground">
                        <RelativeTime at={d.at} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{d.app}</TableCell>
                      <TableCell className="font-mono text-xs">{d.sha.slice(0, 7)}</TableCell>
                      <TableCell>
                        <DeliveryBadge outcome={d.outcome} />
                      </TableCell>
                      <TableCell className="min-w-56 pr-6 whitespace-normal">
                        {d.detail}
                        {d.deploymentId !== null && (
                          <>
                            {" "}
                            <Link href={`/servers/${buildOn ?? serverId}/deployments/${d.deploymentId}`} className="underline underline-offset-4">
                              View the deployment
                            </Link>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
