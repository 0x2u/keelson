import type { Container } from "@/lib/agent-types";

/** The label the agent puts on every container it manages; the agent refuses to start or restart one without it. */
export const APP_LABEL = "keelson.app";

export interface ContainerControls {
  /** A stopped container can be started. */
  start: boolean;
  /** A running (or restarting) container can be restarted. */
  restart: boolean;
  /** Why neither is offered, when neither is. */
  reason?: string;
}

/**
 * Which of Start and Restart to offer for a container: only for the ones the agent manages, only with the deploy
 * secret (the routes are signed) and while no deployment replaces the container, Start when it is not running and
 * Restart when it is.
 */
export function containerControls(state: { running: boolean; restarting?: boolean; paused?: boolean }, opts: { managed: boolean; canDeploy: boolean; deploying?: boolean }): ContainerControls {
  if (!opts.managed) return { start: false, restart: false, reason: "Keelson does not manage this container: it has no app label." };
  if (!opts.canDeploy) return { start: false, restart: false, reason: "This server is read-only here: it has no deploy secret in the dashboard." };
  if (opts.deploying) return { start: false, restart: false, reason: "A deployment is running: it is replacing this container. Wait for it to finish." };
  if (state.paused) return { start: false, restart: false, reason: "The container is paused." };
  const up = state.running || state.restarting === true;
  return { start: !up, restart: up };
}

/** The app a container belongs to, from the list the agent returns (it carries the labels), or undefined. */
export function appOfContainer(containers: Container[] | undefined, name: string): string | undefined {
  return containers?.find((c) => c.name === name)?.labels?.[APP_LABEL] || undefined;
}
