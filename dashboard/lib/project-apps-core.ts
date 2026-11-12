import type { ProxyView } from "@/lib/agent-types";
import { cleanHostname } from "@/lib/address-core";
import { hostsOf, type HostEntry } from "@/lib/domain-status-core";
import type { Placement, Project } from "@/lib/projects-core";

// The Apps and Domains tabs of a project hub: how the placements of a project are laid out. Pure.

const PREVIEW = /^(.+)-pr-\d+$/;

/** One app on one server with the preview instances (`<app>-pr-N`) of the same server that hang under it. */
export interface AppRow {
  placement: Placement;
  previews: Placement[];
}

export interface AppLayoutEnvironment {
  name: string;
  rows: AppRow[];
}

export interface AppLayout {
  environments: AppLayoutEnvironment[];
  /** A preview whose parent is not a placement of the project on that server: listed on its own, never dropped. */
  orphanPreviews: Placement[];
}

/** The app a preview instance belongs to, from its name; null when the name is not a preview's. */
export function previewParent(name: string): string | null {
  const m = PREVIEW.exec(name);
  return m ? m[1] : null;
}

/** Key of a placement, unique across servers. */
export const placementKey = (p: Placement): string => `${p.server.id}/${p.app.name}`;

/** Environments in the project's order; previews are removed from the environments and attached under their parent on the same server. */
export function appLayout(project: Project): AppLayout {
  const all = project.environments.flatMap((e) => e.placements);
  const bySlot = new Map(all.map((p) => [placementKey(p), p]));
  const previews = new Set<Placement>();
  const attached = new Map<string, Placement[]>();
  const orphanPreviews: Placement[] = [];
  for (const p of all) {
    const parent = previewParent(p.app.name);
    if (parent === null) continue;
    const parentPlacement = bySlot.get(`${p.server.id}/${parent}`);
    previews.add(p);
    if (!parentPlacement || previewParent(parentPlacement.app.name) !== null) {
      orphanPreviews.push(p);
      continue;
    }
    attached.set(placementKey(parentPlacement), [...(attached.get(placementKey(parentPlacement)) ?? []), p]);
  }
  const environments = project.environments
    .map((e) => ({
      name: e.name,
      rows: e.placements.filter((p) => !previews.has(p)).map((p) => ({ placement: p, previews: attached.get(placementKey(p)) ?? [] })),
    }))
    .filter((e) => e.rows.length > 0);
  return { environments, orphanPreviews };
}

/** The host names one placement serves: what the proxy routes to the app, then the domains the agent reports for it that the proxy does not list (waiting for a route). */
export function placementHosts(p: Placement, proxy: ProxyView | null): HostEntry[] {
  const hosts = hostsOf(proxy, p.app.name);
  const seen = new Set(hosts.map((h) => h.hostname));
  for (const d of p.app.domains ?? []) {
    const hostname = cleanHostname(d);
    if (!seen.has(hostname)) {
      seen.add(hostname);
      hosts.push({ hostname, label: p.app.name });
    }
  }
  return hosts;
}

/** The proxy routes of the app, for the route table of the Domains tab (sites are not an app's). */
export function routesOf(app: string, proxy: ProxyView | null) {
  return proxy === null ? [] : proxy.routes.filter((r) => r.kind === "app" && r.app === app);
}

/** `?from=` value that brings a config form back to a tab of the project. */
export const fromTab = (project: string, tab: string): string => `from=${encodeURIComponent(`/projects/${encodeURIComponent(project)}/${tab}`)}`;

/** The databases of a project that run in a container Keelson manages (`managed`): an external or declared database has no container to show. */
export function managedDatabases<T extends { db: { managed?: boolean } }>(databases: T[]): T[] {
  return databases.filter((d) => d.db.managed === true);
}
