import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { AttentionRow } from "@/components/home/HomeView";
import { AddAppButton, type AddAppTarget } from "@/components/projects/AddAppButton";
import { ImageRef } from "@/components/image-ref";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, Notice } from "@/components/states";
import { ContainerBadge, DeploymentBadge, ServerStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DefinitionItem, DefinitionList, InlineLink, TableCard } from "@/components/layout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { attentionItems, summarize } from "@/lib/attention-core";
import { duration } from "@/lib/format";
import { triggerLabel } from "@/lib/labels-core";
import { serverListHref } from "@/lib/nav-core";
import { relayStatus } from "@/lib/relay";
import { hubPlacements } from "@/lib/project-hub";
import { groupProjects } from "@/lib/projects-core";
import { getServer } from "@/lib/servers";
import { serverApps, serverDeployments, serverInfo, serverSnapshot, serverSystem } from "@/lib/server-data";
import { ReadinessRow } from "@/components/readiness/ReadinessList";
import { readinessInput } from "@/lib/readiness";
import { forServer, readinessSummary, serverReadiness } from "@/lib/readiness-core";


/** Whether the agent answered at all: a part that fails then is the same news as the rest and is said once, not per section. */
async function answers(id: string): Promise<boolean> {
  return (await serverInfo(id)).error === undefined;
}

/**
 * What a machine that connects out is, on its own page, instead of the verdict a server gets: whether it is connected now,
 * when it was last seen, what it builds for, and where its builds are chosen and configured.
 */
export async function MachineSection({ serverId }: { serverId: string }) {
  const status = relayStatus(serverId);
  const system = status.connected ? await serverSystem(serverId) : null;
  const platform = system?.data?.os !== undefined && system.data.arch !== undefined ? `${system.data.os}/${system.data.arch}` : null;
  return (
    <Card data-testid="machine-status">
      <CardHeader className="flex items-center gap-3">
        <ServerStatusBadge reachable={status.connected} machine />
        <CardTitle>A computer that connects to Keelson</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <DefinitionList className="sm:grid-cols-1 lg:grid-cols-1 gap-y-1">
          <DefinitionItem label="Last seen">
            {status.connected ? "now" : status.lastSeen === null ? "never since this dashboard started" : <RelativeTime at={status.lastSeen} />}
          </DefinitionItem>
          {platform !== null && (
            <DefinitionItem label="Builds for">
              <span className="font-mono">{platform}</span>
            </DefinitionItem>
          )}
        </DefinitionList>
        {!status.connected && (
          <p className="text-muted-foreground">
            Its agent is not running or cannot reach this dashboard. Run <span className="font-mono">keelson-agent connect</span> again on the computer: it reconnects by itself and keeps retrying.
          </p>
        )}
        <p className="text-muted-foreground">
          This server does not serve traffic: nothing can reach what it runs, so it is not offered as a place to deploy. It can still build images: choose it under <em>Build on</em> in an app&apos;s
          Source page and the image is sent to the app&apos;s own server.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The first thing on a server's page: is it fine, and if not, what and where. The same verdict and items the home page
 * and the sidebar use (the attention model), filtered to this server.
 */
export async function StatusSection({ serverId }: { serverId: string }) {
  const snapshot = await serverSnapshot(serverId);
  if (!snapshot.reachable) {
    if (getServer(serverId)?.transport === "relay") {
      return (
        <Notice title="The server is not connected">
          {snapshot.reason}. Its agent opens the connection itself and retries by itself: check on the server that the agent is running (<span className="font-mono">systemctl status keelson-agent</span>) and
          that it can reach this dashboard over HTTPS.
        </Notice>
      );
    }
    return (
      <Notice title="The agent cannot be reached">
        {snapshot.reason}. Check that the agent is running on the server, that the URL in the settings is the one this dashboard can reach, and that the API
        token matches the agent&apos;s token file.{" "}
        <InlineLink href={`/servers/${serverId}/settings`}>Open settings</InlineLink>
      </Notice>
    );
  }
  const items = attentionItems([snapshot]).map((i) => ({ ...i, actions: i.actions.filter((a) => a.href !== `/servers/${serverId}`) }));
  const verdict = summarize(items);
  return (
    <TableCard data-testid="server-status">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <ServerStatusBadge reachable attention={verdict} />
        {verdict.count === 0 && <span className="text-sm text-muted-foreground">Nothing on this server needs a look.</span>}
      </div>
      {items.length > 0 && (
        <ul className="divide-y border-t" data-testid="server-attention">
          {items.map((item) => (
            <AttentionRow key={item.id} item={item} showServer={false} />
          ))}
        </ul>
      )}
    </TableCard>
  );
}

/**
 * What this server must have before it can be trusted, beyond running: an alert channel that has been seen to deliver, and an
 * agent of the version this dashboard carries. The checks of its databases and apps are on their project's Readiness tab.
 * Nothing for an agent that is down (the status above says so).
 */
export async function ReadinessSection({ serverId }: { serverId: string }) {
  const snapshot = await serverSnapshot(serverId);
  if (!snapshot.reachable) return null;
  const now = Date.now(); // eslint-disable-line react-hooks/purity -- a server component renders once per request
  // Only the server's own items: its databases and apps are left out of the input, so their facts are not read here.
  const input = await readinessInput({ server: snapshot.server, reachable: true, version: (await serverInfo(serverId)).data?.version, apps: [], databases: [] });
  const items = forServer(serverReadiness(input, now), serverId);
  if (items.length === 0) return null;
  return (
    <TableCard title="Readiness" description={readinessSummary(items).text} data-testid="server-readiness">
      <ul className="divide-y">
        {items.map((item) => (
          <ReadinessRow key={item.id} item={item} showServer={false} />
        ))}
      </ul>
    </TableCard>
  );
}

/** The apps of the server with what runs and what was last deployed. Hidden for an agent with no apps file, and when the agent is down. */
export async function AppsSection({ serverId, canDeploy, machine = false }: { serverId: string; canDeploy: boolean; machine?: boolean }) {
  const result = await serverApps(serverId);
  if (result.error !== undefined) {
    if (!(await answers(serverId))) return null;
    return <Notice title="Apps could not be listed">{result.error}</Notice>;
  }
  if (result.data === null) return null;
  const apps = result.data;
  // One "Add app": it asks which project the app belongs to (an existing one, or a new one), then opens the form.
  const projects = machine ? [] : groupProjects((await hubPlacements()).placements).map((p) => p.name);
  const target: AddAppTarget = { kind: "project", serverId, serverName: getServer(serverId)?.name ?? serverId, canDeploy, projects };
  return (
    <TableCard
      title="Apps"
      action={
        /* A server that does not serve traffic runs no app: there is none to add by hand. */
        !machine ? <AddAppButton target={target} variant="outline" size="sm" /> : undefined
      }
    >
        {apps.length === 0 ? (
          <EmptyState icon={ICONS.app} title="No apps yet">
            {machine
              ? "This server does not serve traffic, so no app runs on it."
              : "Use Add app to create one: from a ready-made image (such as traefik/whoami) or from a GitHub repository. Nothing to write by hand."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="hidden md:table-cell">Image</TableHead>
                <TableHead>Container</TableHead>
                <TableHead>Last deployment</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((a) => (
                <TableRow key={a.name}>
                  <TableCell>
                    <InlineLink href={`/servers/${serverId}/apps/${encodeURIComponent(a.name)}`}>{a.name}</InlineLink>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{a.container ? <ImageRef value={a.container.image} className="max-w-64" /> : "–"}</TableCell>
                  <TableCell>
                    {a.container ? <ContainerBadge state={a.container.state.status} health={a.container.state.health} /> : <span className="text-muted-foreground">Not deployed</span>}
                  </TableCell>
                  <TableCell>
                    {a.last_deployment ? (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <DeploymentBadge status={a.last_deployment.status} trigger={a.last_deployment.trigger} image={a.last_deployment.ref} />
                        <RelativeTime at={a.last_deployment.started_at} className="text-muted-foreground" />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <ConfigActionLink href={`/servers/${serverId}/config/apps/${encodeURIComponent(a.name)}`} enabled={canDeploy} variant="ghost" size="xs" aria-label={`Edit app ${a.name}`}>
                      Edit
                    </ConfigActionLink>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </TableCard>
  );
}

/**
 * How many jobs and databases the server has and how many need a look, each a link to the global list narrowed to this
 * server (they used to be tabs of the server). Nothing for an agent that is down, or has no apps file.
 */
export async function ScheduledSection({ serverId }: { serverId: string }) {
  const snapshot = await serverSnapshot(serverId);
  if (!snapshot.reachable) return null;
  const items = attentionItems([snapshot]);
  const lists = [
    { kind: "jobs" as const, label: "Jobs", icon: ICONS.job, count: snapshot.jobs?.length, absent: snapshot.jobs === null, look: items.filter((i) => i.kind === "job").length },
    { kind: "databases" as const, label: "Databases", icon: ICONS.database, count: snapshot.databases?.length, absent: snapshot.databases === null, look: items.filter((i) => i.kind === "backup").length },
  ].filter((l) => !l.absent);
  if (lists.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="server-lists">
      {lists.map(({ kind, label, icon: Icon, count, look }) => (
        <Link
          key={kind}
          href={serverListHref(kind, serverId)}
          className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={`${label} on this server${count === undefined ? "" : `: ${count}`}`}
        >
          <Card className="flex-row items-center gap-3 px-5 py-4 transition-colors hover:bg-muted/50">
            <Icon aria-hidden className="size-5 text-muted-foreground" />
            <span className="text-sm font-medium">{label}</span>
            {count !== undefined && <span className="tabular text-sm text-muted-foreground">{count}</span>}
            {look > 0 && <Badge variant="warning">{look} need a look</Badge>}
            <ArrowUpRightIcon aria-hidden className="ml-auto size-4 text-muted-foreground" />
          </Card>
        </Link>
      ))}
    </div>
  );
}

/** The last deployments to this server, newest first. */
export async function DeploymentsSection({ serverId }: { serverId: string }) {
  const result = await serverDeployments(serverId);
  if (result.error !== undefined) {
    if (!(await answers(serverId))) return null;
    return <Notice title="Deployments could not be listed">{result.error}</Notice>;
  }
  const list = result.data;
  return (
    <TableCard title="Recent deployments">
        {list.length === 0 ? (
          <EmptyState icon={ICONS.deploy} title="No deployments yet">
            Deployments to this server are listed here, newest first.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="hidden sm:table-cell">Ref</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="hidden md:table-cell">Trigger</TableHead>
                <TableHead>When</TableHead>
                <TableHead>
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.app}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <ImageRef value={d.ref} className="max-w-64" />
                  </TableCell>
                  <TableCell>
                    <DeploymentBadge status={d.status} trigger={d.trigger} image={d.ref} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{triggerLabel(d.trigger)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime at={d.started_at} />
                    <span className="ml-1 hidden tabular lg:inline">· {duration(d.started_at, d.finished_at)}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="xs">
                      <Link href={`/servers/${serverId}/deployments/${d.id}`} aria-label={`Details of the deployment of ${d.app}`}>
                        Details
                        <ArrowUpRightIcon />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
    </TableCard>
  );
}
