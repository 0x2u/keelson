import type { AppStatus, ConfigModel, DatabaseStatus, JobStatus } from "@/lib/agent-types";
import { previewParent } from "@/lib/project-apps-core";
import { projectOf } from "@/lib/projects-core";

// Which project an entity of a server belongs to, for the shell: it lights Projects and builds the project's breadcrumb for
// the pages of an app, a deployment, a container, a job or a database. The same rules as the hub's membership
// (lib/project-hub-core projectMembers), asked for one entity from what ONE server says: the hub attributes a job or a
// database to an app on the SAME server, so nothing else is needed. An entity no project claims is "unassigned": null.

/** What one server says: the apps, jobs, databases and configuration the rules read. A part that could not be read is empty/null (never guessed). */
export interface OwnerFacts {
  apps: AppStatus[];
  jobs: JobStatus[];
  databases: DatabaseStatus[];
  config: ConfigModel | null;
}

export const noFacts = (): OwnerFacts => ({ apps: [], jobs: [], databases: [], config: null });

const CONTAINER_TARGET = /^container of (.+)$/;

/** The project an app belongs to: its `project` label, else its own name (the app is its project). Null for an app not on the list. */
export function ownerOfApp(apps: AppStatus[], name: string): string | null {
  const app = apps.find((a) => a.name === name);
  return app ? projectOf(app) : null;
}

/** `ownerOfApp` for a name a job or a database may not have. */
function projectOfAppNamed(apps: AppStatus[], name: string | undefined): string | null {
  return name === undefined ? null : ownerOfApp(apps, name);
}

/** Whether an app's own pages move to the hub: a preview instance (`<app>-pr-N`) has the preview scope of its parent instead, so it keeps its server page. */
export const hasHubPages = (app: Pick<AppStatus, "name">): boolean => previewParent(app.name) === null;

/** The project of the database: its label (status, else its entry in the configuration), else the app it was made for, else an app whose release step backs it up. */
export function ownerOfDatabase(facts: OwnerFacts, name: string): string | null {
  const db = facts.databases.find((d) => d.name === name);
  if (!db) return null;
  const label = db.project || facts.config?.databases?.find((c) => c.name === name)?.project;
  if (label) return label;
  const managed = projectOfAppNamed(facts.apps, db.app);
  if (managed !== null) return managed;
  for (const app of facts.config?.apps ?? []) {
    if (app.release?.steps?.some((s) => s.backup === name)) {
      const project = projectOfAppNamed(facts.apps, app.name);
      if (project !== null) return project;
    }
  }
  return null;
}

/** The database a backup job backs up: the one that names it, else `backup-<name>`. */
function backedUp(job: JobStatus, databases: DatabaseStatus[]): string | undefined {
  if (job.kind !== "backup") return undefined;
  return (databases.find((d) => d.backup?.job === job.name) ?? databases.find((d) => job.name === `backup-${d.name}`))?.name;
}

/** The project of the job: its label, else its database's (a backup), else the app it acts on or authenticates as. */
export function ownerOfJob(facts: OwnerFacts, name: string): string | null {
  const job = facts.jobs.find((j) => j.name === name);
  if (!job) return null;
  const config = facts.config?.jobs?.find((c) => c.name === name);
  const label = job.project || config?.project;
  if (label) return label;
  const database = backedUp(job, facts.databases);
  if (database !== undefined) return ownerOfDatabase(facts, database);
  if (job.kind === "container") return projectOfAppNamed(facts.apps, CONTAINER_TARGET.exec(job.target)?.[1] ?? config?.container?.app);
  if (job.kind === "http") return projectOfAppNamed(facts.apps, config?.http?.bearer?.app);
  return null;
}

/** The project of a container: the one of the app it carries the label of (`keelson.app`), else of the database it hosts; null for a container nothing claims. */
export function ownerOfContainer(facts: OwnerFacts, container: { name: string; appLabel?: string }): string | null {
  if (container.appLabel) return ownerOfApp(facts.apps, container.appLabel);
  const db = facts.databases.find((d) => d.host === container.name);
  return db ? ownerOfDatabase(facts, db.name) : null;
}
