import "server-only";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { dataDir, db } from "@/lib/db";

// A copy of this dashboard's own state (servers, tokens, sign-in data, settings): one consistent SQLite file. The credentials
// in it are encrypted with the master key (KEELSON_DASHBOARD_KEY, or master.key in the data directory), which is never in the
// file: the operator keeps it apart, and a copy is useless without it. What a restored dashboard must not inherit is left out
// of the copy (see LEFT_OUT).

/** When a copy was last downloaded (ms), or null when none ever was. */
export function lastBackupAt(): number | null {
  const row = db().prepare("SELECT last_backup_at FROM dashboard_backup WHERE id = 1").get() as { last_backup_at: number } | undefined;
  return row?.last_backup_at ?? null;
}

export function recordBackup(at: number): void {
  db().prepare("INSERT INTO dashboard_backup (id, last_backup_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_backup_at = excluded.last_backup_at").run(at);
}

export interface BackupCopy {
  /** The file name to offer: "keelson-dashboard-20261102-120000.db". */
  name: string;
  size: number;
  /** The copy as a stream; the private directory it lives in is removed when the stream ends or is cancelled. */
  stream: ReadableStream<Uint8Array>;
  /** Removes the copy now, when it will not be sent after all. */
  discard: () => void;
}

/**
 * What a copy does not carry: signed-in sessions, the sign-in throttle, the logins half-way through a second factor, the
 * single-use states of a GitHub App setup, and the
 * first-run setup (the admin password hash set in the browser, its token, its recovery step): a restored dashboard asks for
 * a password again, behind a new token, and a copy that gets lost carries no password to crack.
 */
const LEFT_OUT = ["sessions", "login_failures", "pending_logins", "github_app_states", "admin_password", "setup_token", "setup_recovery"];

/**
 * Makes a consistent copy with `VACUUM INTO` (a snapshot even while the dashboard writes) in a private directory inside the
 * data directory, which is where the live database already is, and so is as writable and as private as it.
 */
export function makeCopy(now: Date = new Date()): BackupCopy {
  const dir = mkdtempSync(path.join(dataDir(), ".backup-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const file = path.join(dir, "copy.db");
  try {
    db().prepare("VACUUM INTO ?").run(file);
    const copy = new DatabaseSync(file);
    try {
      // Deleted rows are overwritten, not just unlinked: their bytes must not stay in the free pages of the file.
      copy.exec("PRAGMA secure_delete = ON");
      for (const table of LEFT_OUT) copy.exec(`DELETE FROM ${table}`);
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const size = statSync(file).size;
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const source = createReadStream(file);
    source.on("close", remove);
    return { name: `keelson-dashboard-${stamp}.db`, size, stream: Readable.toWeb(source) as ReadableStream<Uint8Array>, discard: () => source.destroy() };
  } catch (err) {
    remove();
    throw err;
  }
}
