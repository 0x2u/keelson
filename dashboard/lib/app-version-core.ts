import type { AppStatus, Deployment } from "@/lib/agent-types";

export type AppVersion =
  /** A running container serves this image now. */
  | { kind: "serving"; ref: string }
  /**
   * Nothing serves: the container is stopped, or none exists and the newest successful deployment is the last version
   * known to have run. `at` is when it stopped, or when that deployment started.
   */
  | { kind: "last-known"; ref: string; at?: string; stopped: boolean }
  /** No container and no successful deployment. */
  | { kind: "never" };

/**
 * What to show under "Serving version". Only a running container serves: an exited one, or none, is said so, and the page
 * names the last version that ran (the stopped container's image, else the newest successful deployment), labelled as last
 * known, never as if it served.
 * `history` is null when it could not be loaded; the app's own last deployment is then the only source.
 */
export function appVersion(app: Pick<AppStatus, "container" | "last_deployment">, history: Deployment[] | null): AppVersion {
  const c = app.container;
  if (c?.state.running || c?.state.restarting) return { kind: "serving", ref: c.image };
  if (c) return { kind: "last-known", ref: c.image, at: c.state.finished_at, stopped: true };
  const candidates = [...(history ?? []), ...(app.last_deployment ? [app.last_deployment] : [])].filter((d) => d.status === "succeeded");
  candidates.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  const last = candidates[0];
  return last ? { kind: "last-known", ref: last.ref, at: last.started_at, stopped: false } : { kind: "never" };
}

/** True when no deployment of the app is known: Rollback is not offered then. */
export function neverDeployed(app: Pick<AppStatus, "container" | "last_deployment">, history: Deployment[] | null): boolean {
  return app.container === null && app.last_deployment === null && (history === null || history.length === 0);
}
