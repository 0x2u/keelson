import "server-only";
import { agentFor } from "@/lib/agent";
import { load } from "@/lib/data";
import { canRunApps } from "@/lib/machine-core";
import { projectDeprecations } from "@/lib/deprecations-core";
import { configLocation, derivedProject, type ServerProjectConfig } from "@/lib/project-config-core";
import type { ProjectHub } from "@/lib/project-hub";
import { getCredentials } from "@/lib/servers";

/**
 * Where the project's configuration lives on each server that holds one of its apps: its own file (read whole), the
 * server's shared apps file, or an agent too old to know about project files. A server that does not answer is said to
 * be unavailable with why, never assumed to be one of the others.
 */
export async function loadProjectConfig(hub: ProjectHub): Promise<ServerProjectConfig[]> {
  return Promise.all(
    hub.facts.map(async (facts): Promise<ServerProjectConfig> => {
      const { server } = facts;
      const derived = derivedProject(hub.name, server, facts, hub.members);
      const creds = getCredentials(server.id);
      if (!creds) return { server, machine: false, derived, deprecations: [], source: "unavailable", reason: "this server is no longer registered" };
      const agent = agentFor(creds);
      const document = await load(agent.config());
      const deprecations = projectDeprecations(document.error === undefined ? (document.data?.deprecations ?? []) : [], hub.name, derived);
      const base = { server, machine: !canRunApps(creds), derived, deprecations };
      const files = await load(agent.projectFiles());
      if (files.error !== undefined) return { ...base, source: "unavailable", reason: files.error };
      const location = configLocation(files.data, hub.name);
      if (location === "old-agent") return { ...base, source: "old-agent" };
      if (location === "shared") return { ...base, source: "shared" };
      const doc = await load(agent.projectConfig(hub.name));
      if (doc.error !== undefined) return { ...base, source: "unavailable", reason: doc.error };
      // The file was removed between the two requests: the project is back in the shared file.
      if (doc.data === null) return { ...base, source: "shared" };
      return { ...base, source: "file", doc: doc.data };
    }),
  );
}
