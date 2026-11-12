import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

/** What a health check says is wrong: only a coarse code leaves the server. */
export type HealthVerdict = { ok: true } | { ok: false; reason: "database" | "key" };

const CHECK_VALUE = "keelson-key-check";
const CACHE_MS = 5_000;
let cached: { at: number; verdict: HealthVerdict } | null = null;

/**
 * Whether the dashboard can do its job: its database opens and migrates, and the master key in the environment is the one
 * the data was written with (a secret stored in it decrypts). "Alive" is not enough: a container that started with a wrong
 * key, or on a database it could not migrate, answers requests and fails every one that matters, and the update script
 * keeps a version that "reports healthy".
 *
 * The key is proved against what is stored (a server's token, the authenticator's secret) or, when the database holds no
 * secret yet, against a value written the first time it was healthy (table key_check).
 */
export function checkHealth(now: number = Date.now()): HealthVerdict {
  if (cached && now - cached.at < CACHE_MS) return cached.verdict;
  const verdict = run();
  cached = { at: now, verdict };
  return verdict;
}

/** Forgets the last verdict (tests). */
export function resetHealthCache(): void {
  cached = null;
}

function run(): HealthVerdict {
  let conn;
  try {
    conn = db();
    conn.prepare("SELECT 1").get();
  } catch {
    return { ok: false, reason: "database" };
  }
  try {
    const stored =
      (conn.prepare("SELECT value_enc AS v FROM key_check WHERE id = 1").get() as { v: string } | undefined)?.v ??
      (conn.prepare("SELECT token_enc AS v FROM servers WHERE token_enc IS NOT NULL LIMIT 1").get() as { v: string } | undefined)?.v ??
      (conn.prepare("SELECT totp_secret_enc AS v FROM auth_factor WHERE totp_secret_enc IS NOT NULL LIMIT 1").get() as { v: string } | undefined)?.v;
    if (stored !== undefined) {
      decrypt(stored);
      return { ok: true };
    }
    conn.prepare("INSERT OR IGNORE INTO key_check (id, value_enc) VALUES (1, ?)").run(encrypt(CHECK_VALUE));
    return { ok: true };
  } catch {
    return { ok: false, reason: "key" };
  }
}
