import { hubTabHref, newProjectHref } from "@/lib/nav-core";
import { fromTab } from "@/lib/project-apps-core";

// Where the project's "Add app" and "Add environment" start: the Apps tab opens the matching dialog for `?add=`.
// The palette, the Overview and the Apps tab link here, so the address is spelled once.

/** The Apps tab with the "Add app" dialog open. */
export const addAppHref = (project: string): string => `${hubTabHref(project, "apps")}?add=app`;

/** The Apps tab with the "Add environment" dialog open. */
export const addEnvironmentHref = (project: string): string => `${hubTabHref(project, "apps")}?add=environment`;

/** The form of a new app of a project on a server; saving or cancelling comes back to the project's Apps tab. */
export const newAppOnServerHref = (serverId: string, project: string): string => `/servers/${encodeURIComponent(serverId)}/config/apps/new?${fromTab(project, "apps")}`;

/**
 * What "Add app" on a server leads to: the form of a new app of an existing project (back to that project's Apps tab), or
 * "New project" for this server when the app starts a project of its own.
 */
export const addAppFromServerHref = (serverId: string, project: string | null): string => (project === null ? newProjectHref({ server: serverId }) : newAppOnServerHref(serverId, project));
