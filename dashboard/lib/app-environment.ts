import "server-only";
import { agentFor } from "@/lib/agent";
import type { AppConfig, AppStatus, EnvScope, EnvVars } from "@/lib/agent-types";
import { hasPreviewTemplate } from "@/lib/app-environment-core";
import { load } from "@/lib/data";
import { envPending, lastChanged, portKeysOf, scopeOf, type EnvRules } from "@/lib/env-core";
import type { ServerCredentials } from "@/lib/servers";

/** What the variables of one app need on a page: the app, the scope shown, and the stored names (never values). */
export type AppEnvironment =
  | { kind: "apps-error"; error: string }
  | { kind: "missing" }
  | { kind: "vars-error"; error: string }
  /** The agent has no endpoint for managed variables. */
  | { kind: "too-old" }
  | {
      kind: "ready";
      app: AppStatus;
      appConfig: AppConfig | undefined;
      scope: EnvScope;
      hasPreviews: boolean;
      vars: EnvVars;
      servingImage: string;
      rules: EnvRules;
      pending: { changedAt: string } | null;
      changed: string | null;
    };

/** Reads what the environment page of an app shows. `rawScope` is the `?scope=` query: honoured only for an app with a previews template. */
export async function loadAppEnvironment(server: ServerCredentials, name: string, rawScope?: string | string[]): Promise<AppEnvironment> {
  const agent = agentFor(server);
  const [apps, history, config] = await Promise.all([load(agent.apps()), load(agent.deployments(name, 30)), load(agent.config())]);
  if (apps.error !== undefined) return { kind: "apps-error", error: apps.error };
  const app = apps.data?.find((a) => a.name === name);
  if (!app) return { kind: "missing" };

  const hasPreviews = hasPreviewTemplate(config.data?.model, name);
  const scope = hasPreviews ? scopeOf(rawScope) : "app";
  const vars = await load(agent.envVars(name, scope));
  if (vars.error !== undefined) return { kind: "vars-error", error: vars.error };
  if (vars.data === null) return { kind: "too-old" };

  const appConfig = config.data?.model.apps?.find((a) => a.name === name);
  return {
    kind: "ready",
    app,
    appConfig,
    scope,
    hasPreviews,
    vars: vars.data,
    servingImage: app.container?.image ?? "",
    rules: { portKeys: portKeysOf(appConfig) },
    pending: scope === "app" ? envPending(app, history.data ?? null) : null,
    changed: lastChanged(vars.data),
  };
}
