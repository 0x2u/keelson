import type { DatabaseBackup, RestoreRequest } from "@/lib/agent-types";

/** What the agent accepts as the name of a database to create (it is quoted as an identifier in SQL). */
export const TARGET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** An age secret key: the fixed prefix and 58 characters of bech32. */
const AGE_IDENTITY = /AGE-SECRET-KEY-1[0-9A-Z]{58}/;

/** The name proposed for a restore into a new database: "<database>_restore_<YYYYMMDD>" (UTC), always a valid name. */
export function defaultRestoreTarget(database: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = `_restore_${day}`;
  const base = database.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 63 - suffix.length);
  return /^[A-Za-z_]/.test(base) ? `${base}${suffix}` : `_${base}${suffix}`.slice(0, 63);
}

/**
 * The secret key in what was pasted: the key alone, or a whole key file as `age-keygen` writes it. A single-line
 * field flattens a pasted file to one line, so the key is searched for rather than read line by line. Empty when
 * there is none.
 */
export function extractIdentity(pasted: string): string {
  return AGE_IDENTITY.exec(pasted)?.[0] ?? "";
}

export interface RestoreDraft {
  backup: string;
  identity: string;
  target: string;
  overwrite: boolean;
  confirm: string;
}

export type RestoreProblems = Partial<Record<"backup" | "identity" | "target" | "confirm", string>>;

/** What is wrong with the form, field by field; empty when the restore can be sent. `database` is the live one. */
export function restoreProblems(draft: RestoreDraft, database: string, backups: DatabaseBackup[]): RestoreProblems {
  const problems: RestoreProblems = {};
  if (!backups.some((b) => b.key === draft.backup)) problems.backup = "Choose the backup to restore.";
  if (extractIdentity(draft.identity) === "") problems.identity = "Paste the age secret key: it starts with AGE-SECRET-KEY-1.";
  if (draft.overwrite) {
    if (draft.confirm !== database) problems.confirm = `Type ${database} to confirm.`;
  } else if (draft.target === database) {
    problems.target = "That is the live database. Choose another name, or use the overwrite option.";
  } else if (!TARGET_PATTERN.test(draft.target)) {
    problems.target = "Letters, digits and _, not starting with a digit; up to 63 characters.";
  }
  return problems;
}

/** The request to send. Overwriting the live database restores into it and repeats its name as the confirmation. */
export function restoreRequest(draft: RestoreDraft, database: string): RestoreRequest {
  const identity = extractIdentity(draft.identity);
  if (draft.overwrite) return { backup: draft.backup, identity, target: database, overwrite: true, confirm: draft.confirm };
  return { backup: draft.backup, identity, target: draft.target };
}

/**
 * What an overwrite does, as the agent does it (agent/internal/databases/restore.go): over the live database a safety backup
 * (kind pre-restore) is taken first and nothing is overwritten if it fails. Into a new database nothing existing is touched.
 */
export const OVERWRITE_HELP =
  "Replaces what is in it with the backup, using pg_restore --clean. Only over the live database: the agent first takes a safety backup of what is there now (kind pre-restore) and overwrites nothing if that fails. Restoring into a new database touches nothing that exists.";

export const overwriteConfirmation = (database: string): string =>
  `Replaces what is in ${database} with the backup, using pg_restore --clean. Everything in it that is not in the backup is lost, and applications connected to it will see the change. A safety backup of the current database is taken first (kind pre-restore); if it fails, nothing is overwritten.`;
