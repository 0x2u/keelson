import Link from "next/link";
import { ICONS } from "@/lib/icons";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { ContainerControls } from "@/components/ContainerControls";
import { DeployControls } from "@/components/DeployControls";
import { ImageRef } from "@/components/image-ref";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { DefinitionItem, DefinitionList, InlineLink, PageSection } from "@/components/layout";
import { StatusBadge } from "@/components/status";
import { AddAppButton } from "@/components/projects/AddAppButton";
import { AddEnvironmentButton, type EnvironmentSource } from "@/components/projects/AddEnvironmentButton";
import type { ServerChoice } from "@/lib/project-lifecycle-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Deployment } from "@/lib/agent-types";
import { neverDeployed } from "@/lib/app-version-core";
import { fromTab, placementKey, appLayout } from "@/lib/project-apps-core";
import { placementHealth, type Placement, type Project } from "@/lib/projects-core";


export interface AppDatabase {
  server: { id: string; name: string };
  name: string;
  engine: string;
  /** The container the database runs in (the agent's `host`). */
  container: string;
  app?: string;
}


/** One placement: its state, where it runs, which version, and the actions that answer to it. */
export function AppCard({ placement, history, project, nested = false }: { placement: Placement; history: Deployment[] | null; project: string; nested?: boolean }) {
  const { server, app } = placement;
  const container = app.container;
  const health = placementHealth(app);
  const running = history?.some((d) => d.status === "running") ?? app.last_deployment?.status === "running";
  const containerHref = container ? `/servers/${server.id}/containers/${encodeURIComponent(container.name)}` : null;
  const never = neverDeployed(app, history);
  return (
    <Card className={nested ? "border-dashed" : undefined} data-testid="app-card" data-app={app.name} data-server={server.id}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <CardTitle className="min-w-0 text-base">
          <InlineLink href={`/servers/${server.id}/apps/${encodeURIComponent(app.name)}`} className="break-all">
            {app.name}
          </InlineLink>
        </CardTitle>
        <StatusBadge view={health} />
        {!server.canDeploy && <Badge variant="muted">Read-only server</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <DefinitionList>
          <DefinitionItem label="Server">
            <InlineLink href={`/servers/${server.id}`} className="inline-flex items-center gap-1">
              <ICONS.server aria-hidden className="size-3.5" />
              {server.name}
            </InlineLink>
          </DefinitionItem>
          <DefinitionItem label="Version">{container ? <ImageRef value={container.image} serving /> : never ? <span className="text-muted-foreground">Never deployed</span> : <ImageRef value={app.image} />}</DefinitionItem>
          <DefinitionItem label="Container">
            {container && containerHref ? (
              <>
                <InlineLink href={containerHref}>{container.name}</InlineLink>{" "}
                <span className="text-muted-foreground">{container.state.status}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No container</span>
            )}
          </DefinitionItem>
          <DefinitionItem label="Uptime">
            {container?.state.running && container.state.started_at ? (
              <span className="inline-flex gap-1">
                since <RelativeTime at={container.state.started_at} />
                {container.restart_count > 0 && <span className="text-muted-foreground">· {container.restart_count} restarts</span>}
              </span>
            ) : container ? (
              <span className="text-muted-foreground">
                {container.state.oom_killed ? "Killed for memory" : `Exit code ${container.state.exit_code}`}
              </span>
            ) : (
              <span className="text-muted-foreground">–</span>
            )}
          </DefinitionItem>
        </DefinitionList>
        <div className="flex flex-wrap items-center gap-2">
          {container && <ContainerControls serverId={server.id} name={container.name} state={container.state} managed canDeploy={server.canDeploy} deploying={running} />}
          <DeployControls
            serverId={server.id}
            app={app.name}
            canDeploy={server.canDeploy}
            running={running}
            current={container?.image ?? ""}
            history={history}
            neverDeployed={never}
            source={null}
          />
          {containerHref && (
            <Button asChild variant="outline" size="sm">
              <Link href={containerHref}>
                <ICONS.audit />
                Logs
              </Link>
            </Button>
          )}
          <ConfigActionLink href={`/servers/${server.id}/config/apps/${encodeURIComponent(app.name)}?${fromTab(project, "apps")}`} enabled={server.canDeploy} size="sm">
            <ICONS.edit />
            Edit app
          </ConfigActionLink>
        </div>
      </CardContent>
    </Card>
  );
}


/** What the tab's two "Add" buttons need: the servers an app can go to, and what an environment is made from. */
export interface ProjectAppsAdd {
  servers: ServerChoice[];
  environments: string[];
  sources: EnvironmentSource[];
  /** The names of the apps on each server. */
  appNames: Record<string, string[]>;
}

/** The Apps tab: every placement of the project by environment, previews under their app, and the containers of its databases. `intent` is the dialog `?add=` asks to open. */
export function ProjectApps({
  project,
  histories,
  databases,
  add,
  intent = null,
}: {
  project: Project;
  /** Deployment history by `server/app`; absent or null when the server did not answer for it. */
  histories: Record<string, Deployment[] | null>;
  databases: AppDatabase[];
  add: ProjectAppsAdd;
  intent?: "app" | "environment" | null;
}) {
  const layout = appLayout(project);
  const historyOf = (p: Placement) => histories[placementKey(p)] ?? null;
  const none = layout.environments.length === 0 && layout.orphanPreviews.length === 0;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Each line is one app on one server: where it runs, which version, and what you can do with it.</p>
        <div className="flex flex-wrap items-center gap-2">
          <AddEnvironmentButton
            key={intent === "environment" ? "intent" : "plain"}
            intent={intent === "environment"}
            project={project.name}
            environments={add.environments}
            sources={add.sources}
            servers={add.servers}
            appNames={add.appNames}
          />
          <AddAppButton key={intent === "app" ? "intent" : "plain"} intent={intent === "app"} target={{ kind: "server", project: project.name, choices: add.servers }} />
        </div>
      </div>
      {none && <EmptyState bordered icon={ICONS.app} title="No apps yet">An app of this project appears here once it is added to a server. Add the first one.</EmptyState>}
      {layout.environments.map((env) => (
        <PageSection key={env.name} title={env.name}>
          <div className="space-y-3">
            {env.rows.map((row) => (
              <div key={placementKey(row.placement)} className="space-y-2">
                <AppCard placement={row.placement} history={historyOf(row.placement)} project={project.name} />
                {row.previews.length > 0 && (
                  <div className="space-y-2 border-l pl-4" aria-label={`Previews of ${row.placement.app.name}`}>
                    {row.previews.map((p) => (
                      <AppCard key={placementKey(p)} placement={p} history={historyOf(p)} project={project.name} nested />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </PageSection>
      ))}
      {layout.orphanPreviews.length > 0 && (
        <PageSection title="Previews">
          <div className="space-y-3">
            {layout.orphanPreviews.map((p) => (
              <AppCard key={placementKey(p)} placement={p} history={historyOf(p)} project={project.name} nested />
            ))}
          </div>
        </PageSection>
      )}
      {databases.length > 0 && (
        <PageSection title="Database containers">
          <ul className="divide-y rounded-lg border" data-testid="app-databases">
            {databases.map((d) => (
              <li key={`${d.server.id}/${d.name}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <ICONS.database aria-hidden className="size-4 text-muted-foreground" />
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground">{d.engine}</span>
                <InlineLink href={`/servers/${d.server.id}`}>{d.server.name}</InlineLink>
                <InlineLink href={`/servers/${d.server.id}/containers/${encodeURIComponent(d.container)}`} className="ml-auto">
                  Container and logs
                </InlineLink>
              </li>
            ))}
          </ul>
        </PageSection>
      )}
    </div>
  );
}
