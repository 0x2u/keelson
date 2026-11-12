/**
 * How long the update command may run over SSH. The agent drains for up to 180 s when it is asked to stop (a build or a backup in
 * flight), and the new one then starts and is checked: shorter than that and a forced update on a busy server is reported as a
 * timeout while it goes on.
 */
export const UPGRADE_TIMEOUT_MS = 240_000;

export type UpgradeTimeoutOutcome = { finished: true; version: string } | { finished: false; message: string };

export const UPGRADE_MAY_STILL_RUN = "The update took longer than expected and may still be running: wait a minute and open the server again.";

/**
 * What to make of an update command that did not answer in time, from one more look at the agent: it reports the version this
 * dashboard carries (the update happened; only what the command printed, the renewed client certificate, is missing, and the
 * stored one stays valid), or it reports another version or nothing (it may well be draining or starting still).
 * `running` is the version the agent reported, or null when it did not answer.
 */
export function upgradeTimeoutOutcome(running: string | null, bundled: string | null): UpgradeTimeoutOutcome {
  const version = running?.trim() ?? "";
  if (version !== "" && (bundled === null || version === bundled.trim())) return { finished: true, version };
  return { finished: false, message: UPGRADE_MAY_STILL_RUN };
}
