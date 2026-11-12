import { passwordProblem } from "@/lib/password-rules";

// The pure parts of the first-run setup: what the form checks before it is sent (the same rules the action applies) and the
// text of the recovery file.

export interface SetupFields {
  token: string;
  password: string;
  confirm: string;
}

export interface SetupErrors {
  token?: string;
  password?: string;
  confirm?: string;
}

/** Every problem with the form at once. The token is only checked for being there: whether it is the right one is the server's to say. */
export function setupErrors(fields: SetupFields): SetupErrors {
  const errors: SetupErrors = {};
  if (fields.token.trim() === "") errors.token = "Enter the setup token from the container log";
  const problem = passwordProblem(fields.password);
  if (problem) errors.password = problem;
  if (fields.confirm !== fields.password) errors.confirm = "The two passwords differ";
  return errors;
}

export const RECOVERY_FILE_NAME = "keelson-recovery.txt";

/**
 * The recovery file: the master key and what to do with it, in plain words. Only the generated key is ever written into it
 * (a key from KEELSON_DASHBOARD_KEY is already in the operator's hands).
 */
export function recoveryFileText(keyHex: string, dataDirectory: string, now: Date): string {
  return `Keelson recovery file
Created ${now.toISOString().slice(0, 16).replace("T", " ")} UTC

YOUR MASTER KEY (keep it secret)

KEELSON_DASHBOARD_KEY=${keyHex}

What it is
Keelson encrypts the credentials it keeps for your servers (their tokens, deploy secrets and private keys, the authenticator
secret) with this key. The key itself lives in ${dataDirectory}/master.key and is never part of the copy you download in
Settings > Backup.

What to do with this file
1. Keep it apart from the data volume: in a password manager or on an offline disk, not next to the backups of the volume.
   Whoever has this key and a copy of the data can read every stored credential.
2. Do not lose it. If the key is lost, the stored server credentials become unreadable and cannot be recovered: you would
   add your servers again.
3. It is shown once. Keelson will not offer the key again after you leave the setup screen.

To restore the dashboard on another machine
Start it with the same key (set KEELSON_DASHBOARD_KEY to the value above, or save it as master.key in the data directory),
then put the database copy in the data directory as dashboard.db. Every server and setting is back.
`;
}
