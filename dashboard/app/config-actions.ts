"use server";

import type {
  AppConfig,
  ConfigIssue,
  ConfigValidation,
  DatabaseConfig,
  JobConfig,
  NotificationsConfig,
  SaveOptions,
} from "@/lib/agent-types";
import { agentOf, change, failure, type ConfigActionResult } from "@/lib/config-change";
import * as stepUp from "@/lib/step-up-core";

export type { ConfigActionResult } from "@/lib/config-change";

export type ValidateResult = ConfigValidation | { ok: false; issues: ConfigIssue[]; message: string };

/** Checks a document without writing it: every issue, with line numbers. */
export async function validateConfigAction(serverId: string, content: string): Promise<ValidateResult> {
  const agent = await agentOf(serverId);
  if (!agent) return { ok: false, issues: [], message: "Unknown server." };
  try {
    return await agent.validateConfig(content);
  } catch (err) {
    return { ok: false, issues: [], message: failure(err).message };
  }
}

export async function saveConfigAction(serverId: string, content: string, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveConfig(content, opts), { what: "raw configuration", check: () => stepUp.rawDocument("editor") });
}

export async function saveAppAction(serverId: string, name: string, app: AppConfig, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveApp(name, app, opts), { what: `app ${name}`, check: (m) => stepUp.appChange(stepUp.findApp(m, name), app) });
}

export async function deleteAppAction(serverId: string, name: string, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.deleteApp(name, opts), { what: `removing app ${name}`, check: () => stepUp.appRemoval(name) });
}

export async function saveJobAction(serverId: string, name: string, job: JobConfig, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveJob(name, job, opts), { what: `job ${name}`, check: (m) => stepUp.jobChange(stepUp.findJob(m, name), job) });
}

export async function deleteJobAction(serverId: string, name: string, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.deleteJob(name, opts));
}

export async function saveDatabaseAction(serverId: string, name: string, database: DatabaseConfig, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveDatabase(name, database, opts), { what: `database ${name}`, check: (m) => stepUp.databaseChange(stepUp.findDatabase(m, name), database) });
}

export async function deleteDatabaseAction(serverId: string, name: string, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.deleteDatabase(name, opts), { what: `removing database ${name}`, check: () => stepUp.databaseRemoval(name) });
}

export async function saveNotificationsAction(serverId: string, notifications: NotificationsConfig | null, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.saveNotifications(notifications, opts), { what: "notifications", check: (m) => stepUp.notificationsChange(m?.notifications, notifications) });
}

export async function restoreVersionAction(serverId: string, versionId: number, opts: SaveOptions): Promise<ConfigActionResult> {
  return change(serverId, (a) => a.restoreConfigVersion(versionId, opts), { what: `restoring version ${versionId}`, check: () => stepUp.rawDocument("restore") });
}
