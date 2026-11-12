"use server";

import type { ConfigDocument } from "@/lib/agent-types";
import { agentFor, type AgentClient } from "@/lib/agent";
import { fileEntities, setProjectLabels } from "@/lib/config-labels-core";
import { agentOf, change, failure, refreshConfigPages, type ConfigActionResult } from "@/lib/config-change";
import { loadPlacements } from "@/lib/projects";
import { groupProjects, projectOf, type ServerRef } from "@/lib/projects-core";
import { labelEdits, nameIssue, planAddEnvironment, planRenameProject, renameFacts, type CopySource, type RenameServerFacts } from "@/lib/project-lifecycle-core";
import { getCredentials } from "@/lib/servers";
import { requireSession } from "@/lib/session";
import { stepUpError } from "@/lib/step-up";
import * as stepUp from "@/lib/step-up-core";

// The lifecycle of a project: adding an environment (one more app, labelled) and renaming the project (its label on every
// app, job and database, one save per server). Both plan with the same pure functions the dialogs showed the operator
// (lib/project-lifecycle-core.ts), but on facts read again here: the browser only says what it wants.

const refused = (message: string): ConfigActionResult => ({ ok: false, kind: "error", message, issues: [] });

export interface AddEnvironmentRequest {
  project: string;
  environment: string;
  /** Where the new app runs. */
  serverId: string;
  /** The app to copy the configuration from, or null to start from `image`. */
  from: { serverId: string; app: string } | null;
  image?: string;
}

/** One server's configuration document as the agent serves it now; null when the server is unknown, has no apps file or does not answer. */
async function documentOf(serverId: string): Promise<ConfigDocument | null> {
  const creds = getCredentials(serverId);
  if (!creds) return null;
  try {
    return await agentFor(creds).config();
  } catch {
    return null;
  }
}

async function readDocument(agent: AgentClient): Promise<{ ok: true; doc: ConfigDocument | null } | { ok: false; result: ConfigActionResult }> {
  try {
    return { ok: true, doc: await agent.config() };
  } catch (err) {
    return { ok: false, result: failure(err) };
  }
}

/** Adds the app that is an environment of a project: `<project>-<environment>`, with the project and environment labels, copying the configuration of another environment without its variables and domains. */
export async function addEnvironmentAction(request: AddEnvironmentRequest): Promise<ConfigActionResult> {
  const agent = await agentOf(request.serverId);
  const creds = getCredentials(request.serverId);
  if (!agent || !creds) return refused("Unknown server.");
  const read = await readDocument(agent);
  if (!read.ok) return read.result;
  const doc = read.doc;
  if (doc === null) return refused(`${creds.name} has no configuration to write to, so nothing can be added to it.`);

  const { placements } = await loadPlacements();
  const project = groupProjects(placements).find((p) => p.name === request.project);
  const server: ServerRef = { id: creds.id, name: creds.name, canDeploy: creds.canDeploy };

  let from: CopySource | null = null;
  const copyFrom = request.from;
  if (copyFrom !== null) {
    const placement = placements.find((p) => p.server.id === copyFrom.serverId && p.app.name === copyFrom.app);
    if (!placement) return refused("The environment to copy from could not be found: its server may be unreachable. Reload the page.");
    const sourceDoc = placement.server.id === creds.id ? doc : await documentOf(placement.server.id);
    from = { server: placement.server, app: { name: placement.app.name, image: placement.app.image }, config: sourceDoc?.model.apps?.find((a) => a.name === placement.app.name) ?? null };
  }

  const plan = planAddEnvironment({
    project: request.project,
    environment: request.environment,
    server,
    from,
    image: request.image,
    existingEnvironments: project?.environments.map((e) => e.name) ?? [],
    existingAppNames: (doc.model.apps ?? []).map((a) => a.name),
  });
  if (!plan.ok) return refused(plan.reason);

  return change(request.serverId, (a) => a.saveApp(plan.appName, plan.config, { base_hash: doc.hash, comment: `Environment ${request.environment.trim()} of ${request.project}, added by the dashboard` }), {
    what: `app ${plan.appName}`,
    check: () => stepUp.appChange(undefined, plan.config),
  });
}

/** What one server did of a rename. */
export interface RenameServerResult {
  serverId: string;
  serverName: string;
  ok: boolean;
  /** Why it was not saved. */
  message?: string;
  /** How many entities were relabelled there. */
  changed: number;
}

export type RenameProjectResult = { ok: false; message: string } | { ok: true; servers: RenameServerResult[] };

interface RenameFacts {
  facts: RenameServerFacts[];
  docs: Map<string, ConfigDocument>;
  /** Every project there is (an app without a label is a project named like itself). */
  existingProjects: string[];
}

/**
 * What a rename of `from` has to know, read now: the configuration of every server that holds an app of it. A server that
 * did not answer stops it: the project may have apps there, and renaming without them would split it in two.
 */
async function collectRenameFacts(from: string): Promise<{ ok: true; value: RenameFacts } | { ok: false; message: string }> {
  await requireSession();
  const { placements, unreachable } = await loadPlacements();
  if (unreachable.length > 0) {
    return { ok: false, message: `${unreachable.map((s) => s.name).join(", ")} did not answer. The project may have apps there, and renaming without them would split it in two. Try again when every server answers.` };
  }
  const holders = new Map<string, ServerRef>();
  for (const p of placements) if (projectOf(p.app) === from) holders.set(p.server.id, p.server);
  if (holders.size === 0) return { ok: false, message: `No app of ${from} was found. It may have been renamed or removed: reload the page.` };

  const docs = new Map<string, ConfigDocument>();
  const facts = await Promise.all(
    [...holders.values()].map(async (server): Promise<RenameServerFacts> => {
      const doc = await documentOf(server.id);
      if (doc === null) return { server, entities: [], unreadable: "its configuration could not be read" };
      docs.set(server.id, doc);
      return renameFacts(server, doc.model, fileEntities(doc.content));
    }),
  );
  return { ok: true, value: { facts, docs, existingProjects: [...new Set(placements.map((p) => projectOf(p.app)))] } };
}

export type RenameFactsResult = { ok: false; message: string } | { ok: true; facts: RenameServerFacts[]; existingProjects: string[] };

/** What the rename dialog plans with: the apps, jobs and databases of the project on each server, and the names that are taken. Nothing is written. */
export async function renameFactsAction(project: string): Promise<RenameFactsResult> {
  await requireSession();
  const collected = await collectRenameFacts(project);
  if (!collected.ok) return collected;
  return { ok: true, facts: collected.value.facts, existingProjects: collected.value.existingProjects };
}

/**
 * Renames a project: its label on every app, job and database of it, with ONE save of each server's apps file. Nothing is
 * written until every server has been read, planned and its new file made; a server that cannot be written (read-only, not
 * reachable, a configuration the editor cannot change safely) stops the whole rename, because a half-renamed project is two.
 * Each server is then saved on the hash it was read at, so an edit made in between is refused (and reported) rather than lost.
 */
export async function renameProjectAction(from: string, to: string): Promise<RenameProjectResult> {
  await requireSession();
  const issue = nameIssue("project", to);
  if (issue !== null) return { ok: false, message: issue };
  const collected = await collectRenameFacts(from);
  if (!collected.ok) return collected;
  const { facts, docs, existingProjects } = collected.value;

  const plan = planRenameProject({ from, to, facts, existingProjects });
  if (!plan.ok) return { ok: false, message: plan.reason };
  if (plan.blockers.length > 0) return { ok: false, message: plan.blockers.map((b) => `${b.serverName}: ${b.reason}`).join(" ") };

  const unlocked = await stepUpError(stepUp.projectRename(from, plan.to), `renaming project ${from}`);
  if (unlocked) return { ok: false, message: unlocked };

  const writes: { server: ServerRef; doc: ConfigDocument; content: string; changed: number }[] = [];
  for (const s of plan.servers) {
    const doc = docs.get(s.server.id);
    if (!doc) return { ok: false, message: `${s.server.name}: its configuration could not be read.` };
    const edited = setProjectLabels(doc.content, labelEdits(s), plan.to);
    if (!edited.ok) return { ok: false, message: `${s.server.name}: ${edited.reason}.` };
    writes.push({ server: s.server, doc, content: edited.content, changed: s.changes.length });
  }

  const servers = await Promise.all(
    writes.map(async (w): Promise<RenameServerResult> => {
      const base = { serverId: w.server.id, serverName: w.server.name, changed: w.changed };
      const creds = getCredentials(w.server.id);
      if (!creds) return { ...base, ok: false, message: "this server is no longer registered" };
      try {
        const result = await agentFor(creds).saveConfig(w.content, { base_hash: w.doc.hash, comment: `Project ${from} renamed to ${plan.to} by the dashboard` });
        if (result.ok) {
          refreshConfigPages(w.server.id);
          return { ...base, ok: true };
        }
        if (result.kind === "changed") return { ...base, ok: false, message: "its configuration changed while the rename was prepared: nothing was saved there" };
        const first = result.issues.find((i) => i.severity === "error");
        return { ...base, ok: false, message: result.message ?? first?.message ?? "the agent refused the change" };
      } catch (err) {
        return { ...base, ok: false, message: failure(err).message };
      }
    }),
  );
  return { ok: true, servers };
}
