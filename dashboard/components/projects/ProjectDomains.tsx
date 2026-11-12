import { NetworkIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { ConfigActionLink } from "@/components/config/ConfigActionLink";
import { DomainsCard } from "@/components/domains/DomainsCard";
import { EmptyState } from "@/components/states";
import { StatusBadge } from "@/components/status";
import { PROXY_STATES } from "@/lib/status";
import { Card } from "@/components/ui/card";
import { FormCard, InlineLink, PageSection } from "@/components/layout";
import type { ProxyView } from "@/lib/agent-types";
import { fromTab, placementHosts, placementKey, routesOf, appLayout } from "@/lib/project-apps-core";
import type { Placement, Project } from "@/lib/projects-core";

/** One placement's names: the live DNS, proxy and HTTPS checks (Re-check and the Cloudflare record are on each name), and the routes behind them. */
function PlacementDomains({ placement, proxy, proxyError, cloudflare, project }: { placement: Placement; proxy: ProxyView | null; proxyError?: string; cloudflare: boolean; project: string }) {
  const { server, app } = placement;
  const hosts = placementHosts(placement, proxy);
  const routes = routesOf(app.name, proxy);
  return (
    <section aria-label={`Domains of ${app.name} on ${server.name}`} className="space-y-3" data-testid="placement-domains" data-app={app.name} data-server={server.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{app.name}</h3>
        <span className="text-sm text-muted-foreground">
          on{" "}
          <InlineLink href={`/servers/${server.id}`}>{server.name}</InlineLink>
        </span>
        <InlineLink href={`/servers/${server.id}/proxy`} className="ml-auto inline-flex items-center gap-1 text-sm">
          <NetworkIcon aria-hidden className="size-3.5" />
          Proxy of {server.name}
        </InlineLink>
      </div>
      {proxyError !== undefined && <p className="text-sm text-destructive">The proxy of {server.name} could not be read: {proxyError}. Names below come from the app only.</p>}
      {hosts.length === 0 ? (
        <Card>
          <EmptyState
            icon={ICONS.domain}
            title="No domains yet"
            action={
              <ConfigActionLink href={`/servers/${server.id}/config/apps/${encodeURIComponent(app.name)}?${fromTab(project, "domains")}`} enabled={server.canDeploy}>
                Edit configuration
              </ConfigActionLink>
            }
          >
            {app.name} has no public name. Add a domain in its configuration and the proxy will route it.
          </EmptyState>
        </Card>
      ) : (
        <>
          <DomainsCard serverId={server.id} hosts={hosts} cloudflare={cloudflare} title={`Domains of ${app.name}`} />
          {routes.length > 0 && (
            <div data-testid="route-table">
              <FormCard title="Proxy routes">
                <ul className="divide-y text-sm">
                  {routes.map((r) => (
                    <li key={`${r.app}:${r.upstream}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                      <span className="min-w-0 break-all">{r.domains.length > 0 ? r.domains.join(", ") : r.upstream_name ? `via ${r.upstream_name}` : "no domain"}</span>
                      <span className="font-mono text-xs text-muted-foreground">{r.upstream}</span>
                      <StatusBadge view={r.running ? PROXY_STATES.routeRunning : PROXY_STATES.routeDown} />
                    </li>
                  ))}
                </ul>
              </FormCard>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The Domains tab: for each placement of the project, whether its names work. */
export function ProjectDomains({
  project,
  proxies,
  cloudflare,
}: {
  project: Project;
  /** The proxy of each server by id; `error` when it could not be read. */
  proxies: Record<string, { view: ProxyView | null; error?: string }>;
  cloudflare: boolean;
}) {
  const layout = appLayout(project);
  const placements = [
    ...layout.environments.flatMap((e) => e.rows.flatMap((r) => [r.placement, ...r.previews])),
    ...layout.orphanPreviews,
  ];
  if (placements.length === 0) {
    return <EmptyState bordered icon={ICONS.app} title="No apps yet">Domains appear once the project has an app on a server.</EmptyState>;
  }
  return (
    <div className="space-y-8">
      {layout.environments.map((env) => (
        <PageSection key={env.name} title={env.name} className="space-y-4">
          {env.rows.flatMap((r) => [r.placement, ...r.previews]).map((p) => (
            <PlacementDomains key={placementKey(p)} placement={p} proxy={proxies[p.server.id]?.view ?? null} proxyError={proxies[p.server.id]?.error} cloudflare={cloudflare} project={project.name} />
          ))}
        </PageSection>
      ))}
      {layout.orphanPreviews.length > 0 && (
        <PageSection title="Previews" className="space-y-4">
          {layout.orphanPreviews.map((p) => (
            <PlacementDomains key={placementKey(p)} placement={p} proxy={proxies[p.server.id]?.view ?? null} proxyError={proxies[p.server.id]?.error} cloudflare={cloudflare} project={project.name} />
          ))}
        </PageSection>
      )}
    </div>
  );
}
