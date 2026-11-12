import "server-only";
import { bundledAgentVersion } from "@/lib/agent-binaries";
import type { AppStatus, DatabaseStatus } from "@/lib/agent-types";
import { listPasskeys, totpEnabled } from "@/lib/auth/store";
import { lastBackupAt } from "@/lib/dashboard-backup";
import type { FleetServer } from "@/lib/fleet";
import { placementsOf } from "@/lib/home-core";
import { projectMembers, type ServerFacts } from "@/lib/project-hub-core";
import { groupProjects } from "@/lib/projects-core";
import {
  answerOf,
  assignProjects,
  configAnswer,
  dashboardReadiness,
  projectOwnership,
  serverReadiness,
  type Answer,
  type ReadinessItem,
  type ServerReadinessInput,
} from "@/lib/readiness-core";
import { appHistory, databaseRestoreTests, serverConfig, serverProofs } from "@/lib/server-data";
import type { Deployment, RestoreTest } from "@/lib/agent-types";

// The checklist's facts, read from the agents and from this dashboard's own state, for the pages that show it. Each page asks
// for what it needs: a server's own items, a project's, the fleet's. The judging is lib/readiness-core.

/** What the caller already knows of a server, so it is not asked again: its apps and databases, and the agent's version. */
export interface ReadinessBase {
  server: { id: string; name: string };
  reachable: boolean;
  reason?: string;
  version?: string;
  apps?: AppStatus[] | null;
  databases?: DatabaseStatus[] | null;
  errors?: Record<string, string>;
}

const keyed = async <T>(names: string[], read: (name: string) => Promise<Answer<T>>): Promise<Record<string, Answer<T>>> =>
  Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(n)] as const)));

/** The input of one server: its configuration and proofs, the restore tests of its databases with a backup, the histories of its apps. */
export async function readinessInput(base: ReadinessBase): Promise<ServerReadinessInput> {
  const { id } = base.server;
  const common = { ...base, bundledVersion: bundledAgentVersion() };
  if (!base.reachable) return { ...common, config: { kind: "failed", reason: "no answer" }, proofs: { kind: "failed", reason: "no answer" }, restoreTests: {}, histories: {} };
  const [config, proofs] = await Promise.all([serverConfig(id), serverProofs(id)]);
  const model = configAnswer(config);
  // A preview environment is not in the apps file; it is not judged, so its history is not read.
  const judged = (base.apps ?? []).filter((a) => model.kind !== "ok" || model.value === null || model.value.apps?.some((c) => c.name === a.name));
  const [restoreTests, histories] = await Promise.all([
    keyed<RestoreTest[]>((base.databases ?? []).filter((d) => d.backup !== null).map((d) => d.name), async (name) => answerOf(await databaseRestoreTests(id, name))),
    keyed<Deployment[]>(judged.map((a) => a.name), async (name) => {
      const history = await appHistory(id, name);
      return history.error !== undefined ? { kind: "failed", reason: history.error } : { kind: "ok", value: history.data };
    }),
  ]);
  return { ...common, config: model, proofs: answerOf(proofs), restoreTests, histories };
}

/** Every item of one server: its databases, its apps and itself. */
export async function loadServerReadiness(base: ReadinessBase, now: number): Promise<ReadinessItem[]> {
  return serverReadiness(await readinessInput(base), now);
}

/** The dashboard's own items: its second factor and the copy of its state. */
export function loadDashboardReadiness(now: number): ReadinessItem[] {
  return dashboardReadiness({ totp: totpEnabled(), passkeys: listPasskeys().length, lastBackupAt: lastBackupAt() }, now);
}

/** The base of a server of the fleet as the home page loaded it. */
export const baseOf = (s: FleetServer): ReadinessBase => ({
  server: s.server,
  reachable: s.reachable,
  ...(s.reason === undefined ? {} : { reason: s.reason }),
  ...(s.version === undefined ? {} : { version: s.version }),
  apps: s.apps,
  databases: s.databases,
  ...(s.errors === undefined ? {} : { errors: s.errors }),
});

/**
 * Every item of the fleet and of the dashboard, each database's and app's with its project when one owns it (the hub's own
 * rule: `projectMembers`), so that a project's tab and the home page count the same things.
 */
export async function loadFleetReadiness(fleet: FleetServer[], now: number): Promise<ReadinessItem[]> {
  const inputs = await Promise.all(fleet.map((s) => readinessInput(baseOf(s))));
  const facts: ServerFacts[] = fleet.flatMap((s, i) => {
    const { config } = inputs[i];
    return s.reachable && s.apps ? [{ server: { ...s.server, canDeploy: s.canDeploy }, apps: s.apps, jobs: s.jobs ?? [], databases: s.databases ?? [], config: config.kind === "ok" ? config.value : null }] : [];
  });
  const owners = groupProjects(placementsOf(fleet)).map((p) => projectOwnership(p, projectMembers(p, facts)));
  return assignProjects([...inputs.flatMap((i) => serverReadiness(i, now)), ...loadDashboardReadiness(now)], owners);
}
