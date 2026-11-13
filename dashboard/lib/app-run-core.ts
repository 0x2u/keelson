/** Why the controls that act on a running app (Deploy, Roll back, Promote, Restart) are off for an app that is stopped on purpose (`enabled: false`). */
export const STOPPED_REASON = "Stopped: start it first.";

export interface AppRunControls {
  /** A running app can be stopped. */
  stop: boolean;
  /** A stopped app can be started. */
  start: boolean;
  /** Why the one that applies is off, when it is. */
  reason?: string;
}

/**
 * Which of Stop and Start to offer for an app: Start for one stopped on purpose, Stop for one that has a container (an app
 * that was never deployed has nothing to stop). Both need the deploy secret (the routes are signed), and neither is offered
 * while a deployment runs, which is replacing the container.
 */
export function appRunControls(opts: { stopped: boolean; hasContainer: boolean; canDeploy: boolean; deploying?: boolean }): AppRunControls {
  const wanted = opts.stopped ? "start" : opts.hasContainer ? "stop" : null;
  if (wanted === null) return { stop: false, start: false };
  const offer = { stop: wanted === "stop", start: wanted === "start" };
  if (!opts.canDeploy) return { ...offer, reason: "This server is read-only here: it has no deploy secret in the dashboard." };
  if (opts.deploying) return { ...offer, reason: "A deployment is running: it is replacing this container. Wait for it to finish." };
  return offer;
}
