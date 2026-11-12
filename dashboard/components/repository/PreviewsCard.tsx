import { GitPullRequestIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { INLINE_LINK, InlineLink, TableCard } from "@/components/layout";
import { RelativeTime } from "@/components/relative-time";
import { PreviewDeleteButton } from "@/components/repository/PreviewDeleteButton";
import { PreviewsForm } from "@/components/repository/PreviewsForm";
import { EmptyState, Notice } from "@/components/states";
import { DeliveryBadge, StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Preview } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { commitOfRef } from "@/lib/github-core";
import { PREVIEWS } from "@/lib/status";
import { recentPreviewDeliveries } from "@/lib/webhook-deliveries";

/** Previews of a linked app: the switch, the environments that exist now (from the agent), and what GitHub's recent deliveries did to them. */
export function PreviewsCard({
  serverId,
  app,
  workflow,
  suggestions,
  secretSet,
  canDeploy,
  previews,
}: {
  serverId: string;
  app: string;
  workflow: string | null;
  suggestions: string[];
  secretSet: boolean;
  canDeploy: boolean;
  /** What the agent lists: null for an agent without the previews API. */
  previews: Loaded<Preview[] | null>;
}) {
  const instances = (previews.data ?? []).filter((p) => p.app === app);
  const deliveries = recentPreviewDeliveries(serverId, app, 10);
  return (
    <TableCard
      title="Previews"
      description={
        <>
          When the chosen workflow succeeds on a pull request into the linked branch, GitHub calls this dashboard and the server runs the commit&apos;s image as its own
          environment, <span className="font-mono">{app}-pr-&lt;number&gt;</span>, at the address the server&apos;s <span className="font-mono">previews:</span> template
          gives it. A new push to the pull request deploys it again; closing the pull request removes it, and so does its time limit or the template&apos;s maximum. Pull requests
          from forks never get a preview. Turning previews off does not remove the ones that exist.
        </>
      }
    >
      <div className="grid gap-4 py-4">
        <div className="grid gap-4 px-4">
          {!secretSet && (
            <Notice
              tone="warning"
              title="The GitHub webhook is not set up"
              action={
                <InlineLink href="/settings/integrations" className="text-sm">
                  Set it up in Integrations
                </InlineLink>
              }
            >
              Until a webhook secret exists, this dashboard refuses GitHub&apos;s deliveries and no preview is created or removed. The webhook needs the Workflow runs and
              Pull requests events.
            </Notice>
          )}
          {!canDeploy && (
            <Notice tone="warning" title="This server cannot deploy from here">
              Its deploy access is not in the dashboard, so every preview request would fail. Add it in the server settings.
            </Notice>
          )}
          <PreviewsForm serverId={serverId} app={app} workflow={workflow} suggestions={suggestions} instances={instances.length} />
        </div>

        <div>
          <h3 className="px-4 pb-2 text-sm font-medium">Environments</h3>
          {previews.error !== undefined ? (
            <div className="px-4">
              <Notice title="Could not read the previews">{previews.error}</Notice>
            </div>
          ) : previews.data === null ? (
            <div className="px-4">
              <Notice tone="warning" title="This server's agent has no previews">
                It is older than previews, or has deployments off. Update the agent to use them.
              </Notice>
            </div>
          ) : instances.length === 0 ? (
            <EmptyState compact icon={GitPullRequestIcon} title="No previews yet">
              A preview appears here once a pull request&apos;s workflow succeeds.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pull request</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {instances.map((p) => {
                    const sha = commitOfRef(p.ref);
                    return (
                      <TableRow key={p.name}>
                        <TableCell>
                          <span className="font-medium">#{p.pr}</span> <span className="font-mono text-xs text-muted-foreground">{p.name}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.url.startsWith("https://") ? (
                            <a href={p.url} target="_blank" rel="noreferrer noopener" className={INLINE_LINK}>
                              {p.domain}
                            </a>
                          ) : (
                            p.domain
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge view={PREVIEWS[p.status]} />{" "}
                          {p.deployment_id !== "" && (
                            <InlineLink href={`/servers/${serverId}/deployments/${p.deployment_id}`} className="text-xs">
                              Deployment
                            </InlineLink>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{sha === null ? "-" : sha.slice(0, 7)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          <RelativeTime at={p.expires_at} future />
                        </TableCell>
                        <TableCell>
                          <PreviewDeleteButton serverId={serverId} app={app} pr={p.pr} name={p.name} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div>
          <h3 className="px-4 pb-2 text-sm font-medium">Latest deliveries</h3>
          {deliveries.length === 0 ? (
            <EmptyState compact icon={ICONS.deploy} title="No deliveries yet">
              Deliveries for this app&apos;s previews appear here once GitHub reports a successful run of the workflow on a pull request.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Preview</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((d) => (
                    <TableRow key={`${d.deliveryId}/${d.app}`}>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime at={d.at} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{d.app}</TableCell>
                      <TableCell className="font-mono text-xs">{d.sha.slice(0, 7)}</TableCell>
                      <TableCell>
                        <DeliveryBadge outcome={d.outcome} />
                      </TableCell>
                      <TableCell className="min-w-56 whitespace-normal">
                        {d.detail}
                        {d.deploymentId !== null && (
                          <>
                            {" "}
                            <InlineLink href={`/servers/${serverId}/deployments/${d.deploymentId}`}>View the deployment</InlineLink>
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
      </div>
    </TableCard>
  );
}
