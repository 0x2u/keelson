import { DomainsCard } from "@/components/domains/DomainsCard";
import type { ProxyView } from "@/lib/agent-types";
import type { Loaded } from "@/lib/data";
import { hostsOf } from "@/lib/domain-status-core";
import { ImageRef } from "@/components/image-ref";
import { cloudflareSummary } from "@/lib/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PROXY_DOCS_URL } from "@/lib/public-url-help-core";
import { FormCard, TableCard } from "@/components/layout";
import { ICONS } from "@/lib/icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Notice } from "@/components/states";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status";
import { PROXY_STATES } from "@/lib/status";

const LABEL = { caddy: "Caddy", nginx: "nginx" } as const;

/** What the reverse proxy exposes: each domain, where it goes, the version behind it, and what the agent generates for it. */
export async function ProxyOverview({ serverId, proxy }: { serverId: string; proxy: Promise<Loaded<ProxyView | null>> }) {
  const result = await proxy;
  if (result.error !== undefined) return <Notice title="The proxy could not be read">{result.error}</Notice>;
  if (result.data === null) {
    return (
      <EmptyState
        bordered
        icon={ICONS.domain}
        title="No reverse proxy yet"
        action={
          <Button asChild variant="outline" size="sm">
            <a href={PROXY_DOCS_URL} target="_blank" rel="noreferrer">
              How to serve apps on a domain
            </a>
          </Button>
        }
      >
        This server&apos;s configuration has no proxy yet. Add a <code className="font-mono text-xs">proxy</code> section and an app with a
        domain to serve it on that name. Without one, containers publish their own ports.
      </EmptyState>
    );
  }
  const p = result.data;

  return (
    <div className="space-y-6">
      {p.in_sync === false && (
        <Notice tone="warning" title={`${LABEL[p.type]} does not serve what the agent generates`}>
          {p.live_error ? `${p.live_error}. ` : ""}
          {p.type === "nginx"
            ? "The upstreams file differs from the one below: it was edited by hand, or a reload is pending. The agent rewrites it at the next deployment."
            : "Caddy's routes differ from the ones below. The agent loads them again at the next deployment."}
        </Notice>
      )}
      {p.in_sync === undefined && p.live_error && (
        <Notice tone="warning" title={`${LABEL[p.type]} could not be read`}>
          {p.live_error}
        </Notice>
      )}

      <TableCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            Routes
            <Badge variant="muted">{LABEL[p.type]}</Badge>
            {p.in_sync === true && <StatusBadge view={PROXY_STATES.inSync} />}
          </span>
        }
        description={
          <>
            {p.type === "nginx" ? "Upstreams file" : "Admin API"}: <span className="font-mono text-xs">{p.where}</span>
          </>
        }
      >
          {p.routes.length === 0 ? (
            <EmptyState icon={ICONS.domain} title="No routes yet">
              A route appears when an app behind the proxy has been deployed.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App or site, and domains</TableHead>
                  <TableHead>Upstream</TableHead>
                  <TableHead className="hidden md:table-cell">Serving</TableHead>
                  <TableHead className="hidden sm:table-cell">Container</TableHead>
                  <TableHead className="text-right">Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.routes.map((r) => {
                  const site = r.kind === "site";
                  return (
                    <TableRow key={site ? `site:${r.domains.join(",")}` : r.app}>
                      <TableCell>
                        <div className="font-medium">{site ? r.domains[0] ?? "site" : r.app}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {site
                            ? `${r.site_kind ?? "site"}${r.domains.length > 1 ? `, also ${r.domains.slice(1).join(", ")}` : ""}`
                            : r.domains.length > 0
                              ? r.domains.join(", ")
                              : r.upstream_name
                                ? `via ${r.upstream_name}`
                                : "no domain"}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{site ? r.target || r.upstream : r.upstream}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {site || !r.ref ? null : <ImageRef value={r.ref} className="max-w-64" />}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {site ? (
                          <StatusBadge view={PROXY_STATES.site} />
                        ) : (
                          <StatusBadge view={r.running ? PROXY_STATES.routeRunning : PROXY_STATES.routeDown} />
                        )}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{site ? "" : <RelativeTime at={r.updated_at} />}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
      </TableCard>

      {p.unrouted.length > 0 && (
        <Notice tone="info" title={p.unrouted.length === 1 ? "One app has no route" : `${p.unrouted.length} apps have no route`}>
          {p.unrouted.map((u) => `${u.app}${u.domains.length > 0 ? ` (${u.domains.join(", ")})` : ""}: ${u.reason}`).join(" · ")}
        </Notice>
      )}

      <DomainsCard serverId={serverId} hosts={hostsOf(p)} cloudflare={cloudflareSummary() !== null} />

      <FormCard
        title="Generated configuration"
        description={
          <>
            What the agent writes for the routes above ({p.type === "nginx" ? "include it from the http block and point proxy_pass at these upstreams" : "the routes of the keelson server"}).
            Read-only: it changes with deployments.
          </>
        }
      >
        <pre tabIndex={0} aria-label="Generated configuration" className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">{p.generated}</pre>
      </FormCard>
    </div>
  );
}
