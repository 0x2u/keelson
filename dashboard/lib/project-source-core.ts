import { managedPlacements, placementSlot } from "@/lib/project-variables-core";
import type { Placement, Project } from "@/lib/projects-core";

// The Source tab of a project: the repository of one of its apps. Most projects have one app per environment, and the
// first environment's first app is the one the project is shipped from; the others are one click away.

export interface SourceChoice {
  placement: Placement;
  environment: string;
}

/** Every app that can be linked to a repository, the primary one first. Previews are not (they follow their parent). */
export function sourceChoices(project: Project): SourceChoice[] {
  return project.environments.flatMap((e) => managedPlacements(e).map((placement) => ({ placement, environment: e.name })));
}

/** The app a request asks for (`<server id>/<app>`); the primary one when absent or unknown. Null when the project has no app. */
export function pickSourceApp(project: Project, app: string | undefined): { choices: SourceChoice[]; chosen: SourceChoice } | null {
  const choices = sourceChoices(project);
  const chosen = choices.find((c) => placementSlot(c.placement) === app) ?? choices[0];
  return chosen ? { choices, chosen } : null;
}

/** Where the Source tab of an app leads: the primary one needs no query. */
export function sourceHref(project: string, slot?: string): string {
  return `/projects/${encodeURIComponent(project)}/source${slot ? `?app=${encodeURIComponent(slot)}` : ""}`;
}
