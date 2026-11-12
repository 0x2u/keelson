import type { AppStatus, Container, DatabaseStatus, JobRun } from "@/lib/agent-types";
import type { ApiToken } from "@/lib/api-tokens-core";
import type { ServerSummary } from "@/lib/servers";

// What /api/v1 says about things: the shapes of lib/agent-types.ts, minus whatever a lower-trust reader has no use for.

/** A job run's output, as much as this: a script's output is the likeliest place for something that should not travel. */
export const RUN_OUTPUT_MAX = 16 * 1024;

export interface ServerView {
  id: string;
  name: string;
  url: string;
  online: boolean;
  agent_version: string | null;
  update_available: boolean;
  can_deploy: boolean;
}

/** Whether the token can deploy on a server: it needs the deploy scope, and the server a deploy secret in this dashboard. */
export function canDeployWith(token: Pick<ApiToken, "scope">, serverCanDeploy: boolean): boolean {
  return token.scope === "deploy" && serverCanDeploy;
}

/** A server as the API shows it: never a token, a deploy secret, a certificate or a key. `can_deploy` is about this token. */
export function serverView(
  s: ServerSummary,
  token: Pick<ApiToken, "scope">,
  state: { online: boolean; agentVersion: string | null; updateAvailable: boolean },
): ServerView {
  return { id: s.id, name: s.name, url: s.url, online: state.online, agent_version: state.agentVersion, update_available: state.updateAvailable, can_deploy: canDeployWith(token, s.canDeploy) };
}

/**
 * An app without anything about its managed variables: they are the dashboard's own (a session, never an
 * API token), so not even the time of their last change leaves through the API.
 */
export type AppView = Omit<AppStatus, "env_changed_at">;

export function appView(a: AppStatus): AppView {
  const { env_changed_at: _env, ...rest } = a;
  void _env;
  return rest;
}

/** A container without its command line: arguments are where passwords end up. */
export type ContainerView = Omit<Container, "command">;

export function containerView(c: Container): ContainerView {
  const { command: _command, ...rest } = c;
  void _command;
  return rest;
}

export type BackupState = "no_backup" | "paused" | "running" | "failed" | "ok" | "never_run";

export type DatabaseView = DatabaseStatus & {
  /** The state of its scheduled backup, for a reader that does not want to work it out. */
  backup_state: BackupState;
};

export function backupState(d: Pick<DatabaseStatus, "backup">): BackupState {
  const b = d.backup;
  if (!b) return "no_backup";
  if (b.last_run?.status === "running") return "running";
  if (b.paused) return "paused";
  if (!b.last_run) return "never_run";
  return b.last_run.status === "failed" ? "failed" : "ok";
}

export function databaseView(d: DatabaseStatus): DatabaseView {
  return { ...d, backup_state: backupState(d) };
}

export function runView(r: JobRun): JobRun {
  if (r.output === undefined || r.output.length <= RUN_OUTPUT_MAX) return r;
  return { ...r, output: `${r.output.slice(0, RUN_OUTPUT_MAX)}\n[output cut at ${RUN_OUTPUT_MAX} characters]` };
}

