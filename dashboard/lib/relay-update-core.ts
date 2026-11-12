/** How long the page waits for a server to report the new version after it showed the command, before it says so. */
export const UPDATE_WATCH_MS = 5 * 60_000;

/** What the dashboard saw of a server whose agent is being replaced from the server itself. */
export type UpdateProgress =
  | { state: "updated"; version: string }
  /** `running` is the version the agent reported, or null when it did not answer (it restarts during the update). */
  | { state: "waiting"; running: string | null }
  | { state: "timeout"; running: string | null };

export interface UpdateObservation {
  /** The agent version this dashboard carries, or null when it cannot tell. */
  bundled: string | null;
  /** The version the server's agent reported just now, or null when it did not answer. */
  running: string | null;
  /** When the server's agent last connected to the dashboard (ms), or null while it is not connected. */
  connectedAt: number | null;
  /** When the command was made (ms): an agent that connected since was restarted since. */
  since: number;
  /** When the page began (or began again) to wait, and now (ms): the wait ends 5 minutes after. */
  watchFrom: number;
  now: number;
}

/**
 * Decides what to tell about an update the operator runs on the server. Updated means the agent reports the version this
 * dashboard carries; when the server already ran that version (updating again reinstalls it) the version proves nothing, so
 * the agent must also have connected again since the command was made, which is what a restart does.
 */
export function updateProgress(o: UpdateObservation): UpdateProgress {
  const restarted = o.connectedAt !== null && o.connectedAt >= o.since;
  const there = o.running !== null && (o.bundled === null || o.running === o.bundled);
  if (there && restarted && o.running !== null) return { state: "updated", version: o.running };
  if (o.now - o.watchFrom >= UPDATE_WATCH_MS) return { state: "timeout", running: o.running };
  return { state: "waiting", running: o.running };
}

/** The sentence for a progress, in the words of the page. */
export function updateMessage(p: UpdateProgress): string {
  switch (p.state) {
    case "updated":
      return `Updated to ${p.version}`;
    case "waiting":
      return p.running === null ? "Waiting for the server to answer" : `Still on ${p.running}, waiting`;
    case "timeout":
      return "Not updated yet: run the command on the server and check its output";
  }
}
