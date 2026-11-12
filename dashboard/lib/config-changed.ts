import type { ConfigVersion, ConfigVersionContent, Deployment } from "@/lib/agent-types";
import { configChangedSince, containerConfigChanged, secretsOnlyChanged, type ConfigChangedSince } from "@/lib/app-config-core";

/** The three agent calls the badge needs (the agent client has them). */
export interface ConfigHistorySource {
  configVersions(limit: number): Promise<ConfigVersion[]>;
  configVersion(id: number): Promise<ConfigVersionContent>;
  deployments(app: string, limit: number): Promise<Deployment[]>;
}

/** The agent keeps every version but lists at most this many; the deployments list is capped at 100 by the agent. */
const VERSIONS = 50;
const DEPLOYMENTS = 50;

/**
 * The configuration change of one app that its running version does not have yet, or null: nothing changed, the history
 * cannot tell (too old, nothing deployed yet), or the agent could not be asked. A failure to load is never an error: the
 * badge is a hint, it must not block the page it sits on.
 *
 * Limit: the agent keeps one history for the whole file and hides secret values in what it serves, so the app's own
 * section is compared (`containerConfigChanged`), and a version that differs only by a secret counts as a change
 * (`secretsOnlyChanged`) even when it was another entity's secret.
 */
export async function findConfigChange(source: ConfigHistorySource, app: string): Promise<ConfigChangedSince | null> {
  try {
    const [versions, deployments] = await Promise.all([source.configVersions(VERSIONS), source.deployments(app, DEPLOYMENTS)]);
    const since = configChangedSince(versions, deployments, app);
    if (since === null) return null;
    const [then, now] = await Promise.all([source.configVersion(since.then.id), source.configVersion(since.now.id)]);
    return containerConfigChanged(then.content, now.content, app) || secretsOnlyChanged(then, now) ? since : null;
  } catch {
    return null;
  }
}
