import { hubTabHref } from "@/lib/nav-core";

// Where the old addresses lead now: one canonical place per thing. Pure; the pages that used to be there call these and redirect.

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** `/projects/<p>/services`, the hub's old name for its Apps tab. */
export const appsTabHref = (project: string): string => hubTabHref(project, "apps");

/** The Source tab of a project, on one of its apps (`<server>/<app>`): where `/servers/<id>/apps/<app>/source` of a project's app leads. */
export function appSourceHref(project: string, serverId: string, app: string): string {
  return `${hubTabHref(project, "source")}?app=${encodeURIComponent(`${serverId}/${app}`)}`;
}

/** The Variables tab of a project, on one of its apps; the preview scope (`?scope=preview`) is kept. Where `/servers/<id>/apps/<app>/environment` of a project's app leads. */
export function appVariablesHref(project: string, serverId: string, app: string, query: Query = {}): string {
  const params = new URLSearchParams({ app: `${serverId}/${app}` });
  if (one(query.scope) === "preview") params.set("scope", "preview");
  return `${hubTabHref(project, "variables")}?${params.toString()}`;
}

/** The Activity feed filtered by what it can be filtered by: a server, a project, a kind. Nothing set is the whole feed. */
export function activityHref(filter: { server?: string; project?: string; kind?: string } = {}): string {
  const params = new URLSearchParams();
  if (filter.server) params.set("server", filter.server);
  if (filter.project) params.set("project", filter.project);
  if (filter.kind) params.set("kind", filter.kind);
  const text = params.toString();
  return text === "" ? "/activity" : `/activity?${text}`;
}

/** The audit log of a server was folded into Activity (the changes of that server). */
export const serverActivityHref = (serverId: string): string => activityHref({ server: serverId });

/** The notification settings: the fleet table, or (with a server) that server's own form. */
export const notificationsHref = (serverId?: string): string => (serverId === undefined ? "/settings/notifications" : `/servers/${encodeURIComponent(serverId)}/config/notifications`);
