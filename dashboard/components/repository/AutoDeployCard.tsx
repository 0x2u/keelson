import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { RelativeTime } from "@/components/relative-time";
import { AutoDeployForm } from "@/components/repository/AutoDeployForm";
import { EmptyState, Notice } from "@/components/states";
import { DeliveryBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isBuildRunKey } from "@/lib/github-webhook-core";
import { recentDeliveries } from "@/lib/webhook-deliveries";

/** Automatic deploys of a linked app: the switch, and what GitHub's recent deliveries did to it. */
export function AutoDeployCard({
  serverId,
  app,
  workflow,
  suggestions,
  secretSet,
  canDeploy,
}: {
  serverId: string;
  app: string;
  workflow: string | null;
  suggestions: string[];
  secretSet: boolean;
  canDeploy: boolean;
}) {
  // Builds started by the GitHub App have a card of their own.
  const deliveries = recentDeliveries(serverId, app, 30)
    .filter((d) => !isBuildRunKey(d.runKey))
    .slice(0, 10);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic deploys</CardTitle>
        <CardDescription>
          When the chosen workflow succeeds on the linked branch, GitHub calls this dashboard and the commit&apos;s image is deployed to {app}. A run that finishes
          after a newer commit is already serving is skipped, and so is a commit that is already serving or one that cannot be placed against it.
          If the agent does not answer the deploy request in time the outcome is shown as Unknown: the deployment may have started, and the same
          commit is not deployed again until the app can be read.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-0">
        <div className="grid gap-4 px-6">
          {!secretSet && (
            <Notice
              tone="warning"
              title="The GitHub webhook is not set up"
              action={
                <Link href="/settings/integrations" className="text-sm font-medium underline underline-offset-4">
                  Set it up in Integrations
                </Link>
              }
            >
              Until a webhook secret exists, this dashboard refuses GitHub&apos;s deliveries and nothing deploys automatically.
            </Notice>
          )}
          {!canDeploy && (
            <Notice tone="warning" title="This server cannot deploy from here">
              Its deploy access is not in the dashboard, so every automatic deploy would fail. Add it in the server settings.
            </Notice>
          )}
          <AutoDeployForm serverId={serverId} app={app} workflow={workflow} suggestions={suggestions} />
        </div>

        <div>
          <h3 className="px-6 pb-2 text-sm font-medium">Latest deliveries</h3>
          {deliveries.length === 0 ? (
            <EmptyState icon={ICONS.deploy} title="Nothing received yet">
              Deliveries for this app appear here once GitHub reports a successful run of the workflow.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">When</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="pr-6">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((d) => (
                    <TableRow key={d.deliveryId}>
                      <TableCell className="pl-6 text-muted-foreground">
                        <RelativeTime at={d.at} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{d.sha.slice(0, 7)}</TableCell>
                      <TableCell>
                        <DeliveryBadge outcome={d.outcome} />
                      </TableCell>
                      <TableCell className="min-w-56 pr-6 whitespace-normal">
                        {d.detail}
                        {d.deploymentId !== null && (
                          <>
                            {" "}
                            <Link href={`/servers/${serverId}/deployments/${d.deploymentId}`} className="underline underline-offset-4">
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
