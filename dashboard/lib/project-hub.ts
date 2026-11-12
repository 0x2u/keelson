import "server-only";
import { cache } from "react";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { projectMembers, type ProjectMembers, type ServerFacts } from "@/lib/project-hub-core";
import { loadProjectPage, type ProjectPage } from "@/lib/project-page";
import { loadPlacements } from "@/lib/projects";
import { groupProjects, type Placement, type Project } from "@/lib/projects-core";
import { serverDatabases, serverJobs } from "@/lib/server-data";
import { getCredentials } from "@/lib/servers";

// Everything the pages of one project read: its apps, and the jobs, databases and configuration of each server that holds
// one, so that every tab derives its members from the same facts. Started once per request however many tabs ask.

export interface ProjectHub {
  name: string;
  project: Project;
  /** Servers that did not answer, with why: what they hold is missing from the page, and the page says so. */
  unreachable: { id: string; name: string; reason: string }[];
  facts: ServerFacts[];
  members: ProjectMembers;
  generatedAt: number;
}

/** The apps of every server, once per request (the layout and the tab share it). */
export const hubPlacements = cache(() => loadPlacements());

async function factsOf(serverId: string, placements: Placement[]): Promise<{ facts?: ServerFacts; failed?: { id: string; name: string; reason: string } }> {
  const mine = placements.filter((p) => p.server.id === serverId);
  const server = mine[0].server;
  const creds = getCredentials(serverId);
  if (!creds) return { failed: { id: server.id, name: server.name, reason: "this server is no longer registered" } };
  const [jobs, databases, config] = await Promise.all([serverJobs(serverId), serverDatabases(serverId), load(agentFor(creds).config())]);
  // A part that failed is not "empty": the server is named as one that did not answer.
  const error = jobs.error ?? databases.error;
  if (error !== undefined) return { failed: { id: server.id, name: server.name, reason: error } };
  return {
    facts: {
      server,
      apps: mine.map((p) => p.app),
      jobs: jobs.data ?? [],
      databases: databases.data ?? [],
      config: config.error === undefined && config.data !== null ? config.data.model : null,
    },
  };
}

/** The hub of one project; null when no server has an app of that name (a server that did not answer is listed in `unreachable`, never guessed about). */
export const loadProjectHub = cache(async (name: string): Promise<ProjectHub | null> => {
  const generatedAt = Date.now();
  const { placements, unreachable } = await hubPlacements();
  const project = groupProjects(placements).find((p) => p.name === name);
  if (!project) return null;
  const ids = [...new Set(project.environments.flatMap((e) => e.placements).map((p) => p.server.id))];
  const loaded = await Promise.all(ids.map((id) => factsOf(id, placements)));
  const facts = loaded.flatMap((l) => (l.facts ? [l.facts] : []));
  const failed = loaded.flatMap((l) => (l.failed ? [l.failed] : []));
  return {
    name,
    project,
    unreachable: [...unreachable.map((s) => ({ id: s.id, name: s.name, reason: s.reason })), ...failed],
    facts,
    members: projectMembers(project, facts),
    generatedAt,
  };
});

/** What the project's header and overview read beyond the hub (deployments, where it builds, the linked repository), once per request. */
export const hubPage: (project: Project) => Promise<ProjectPage> = cache((project: Project) => loadProjectPage(project));
