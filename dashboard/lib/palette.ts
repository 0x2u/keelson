import "server-only";
import { agentFor } from "@/lib/agent";
import { APP_LABEL } from "@/lib/container-core";
import { hostsOf } from "@/lib/domain-status-core";
import { load } from "@/lib/data";
import { ownerOfApp, ownerOfDatabase, ownerOfJob, type OwnerFacts } from "@/lib/owner-core";
import { INDEX_LIMITS, type PaletteIndex } from "@/lib/palette-core";
import { environmentOf, projectOf } from "@/lib/projects-core";
import { getCredentials, listServers } from "@/lib/servers";

/** How long one answer serves every palette that opens meanwhile: the palette opens often, an agent should not hear of it each time. */
const TTL_MS = 20_000;

let cached: { at: number; value: PaletteIndex } | undefined;
let inflight: Promise<PaletteIndex> | undefined;

/** One server's part of the index; a part the agent cannot give (older, read-only, down) is empty, never an error. */
async function indexServer(s: { id: string; name: string; canDeploy: boolean }): Promise<Omit<PaletteIndex, "servers" | "truncated">> {
  const creds = getCredentials(s.id);
  if (!creds) return { apps: [], jobs: [], databases: [], containers: [], domains: [] };
  const agent = agentFor(creds);
  const [apps, jobs, databases, containers, proxy, config] = await Promise.all([
    load(agent.apps()),
    load(agent.jobs()),
    load(agent.databases()),
    load(agent.containers(true)),
    load(agent.proxy()),
    load(agent.config()),
  ]);
  const server = { id: s.id, name: s.name, canDeploy: s.canDeploy };
  // What owns what is read from this one server's parts (see lib/owner-core); a part that failed is empty, so what it would have claimed stays unowned.
  const facts: OwnerFacts = { apps: apps.data ?? [], jobs: jobs.data ?? [], databases: databases.data ?? [], config: config.data?.model ?? null };
  const project = (owner: string | null) => (owner === null ? {} : { project: owner });
  return {
    apps: facts.apps.map((a) => ({ server, name: a.name, project: projectOf(a), environment: environmentOf(a), image: a.image, serving: a.container !== null, deployed: a.last_deployment !== null })),
    jobs: facts.jobs.map((j) => ({ server, name: j.name, ...project(ownerOfJob(facts, j.name)), schedule: j.schedule, running: j.running, paused: j.paused })),
    databases: facts.databases.map((d) => ({ server, name: d.name, ...project(ownerOfDatabase(facts, d.name)), target: `${d.user}@${d.host}:${d.port}/${d.database}` })),
    containers: (containers.data ?? []).map((c) => ({ server, name: c.name, running: c.state === "running" || c.state === "restarting", managed: Boolean(c.labels?.[APP_LABEL]), app: c.labels?.[APP_LABEL] || undefined })),
    // A host belongs to the project of its app (the label is the app's name; a site's is "site" and has none).
    domains: hostsOf(proxy.data ?? null).map((h) => ({ server, hostname: h.hostname, ...project(ownerOfApp(facts.apps, h.label)), label: h.label })),
  };
}

async function build(): Promise<PaletteIndex> {
  const servers = listServers();
  const parts = await Promise.all(servers.map(indexServer));
  const cap = <T>(lists: T[][], limit: number) => ({ items: lists.flat().slice(0, limit), cut: lists.reduce((n, l) => n + l.length, 0) > limit });
  const apps = cap(parts.map((p) => p.apps), INDEX_LIMITS.apps);
  const jobs = cap(parts.map((p) => p.jobs), INDEX_LIMITS.jobs);
  const databases = cap(parts.map((p) => p.databases), INDEX_LIMITS.databases);
  const containers = cap(parts.map((p) => p.containers), INDEX_LIMITS.containers);
  const domains = cap(parts.map((p) => p.domains), INDEX_LIMITS.domains);
  return {
    servers: servers.map((s) => ({ id: s.id, name: s.name, url: s.url, canDeploy: s.canDeploy })),
    apps: apps.items,
    jobs: jobs.items,
    databases: databases.items,
    containers: containers.items,
    domains: domains.items,
    truncated: [apps, jobs, databases, containers, domains].some((l) => l.cut),
  };
}

/**
 * What the command palette searches, for the whole fleet, bounded (see INDEX_LIMITS) and shared for a few seconds between
 * callers: concurrent opens wait for one load. Behind the dashboard's session only (the route checks it); never the API v1.
 */
export function paletteIndex(): Promise<PaletteIndex> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  inflight ??= build()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
