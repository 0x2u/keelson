import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, db } from "@/lib/db";

/**
 * Configuration comes from the environment. Everything is read lazily so that
 * `next build` does not need secrets, and so tests can set variables first.
 *
 * The environment always wins. Two things have a second home so that a first install needs no variables: the master key
 * (a file in the data directory, created on the first start) and the operator's password (set in the browser at first run,
 * stored hashed in the database). A variable that is set replaces them, whatever they hold.
 */

const KEY_FILE = "master.key";
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/** Where the generated master key lives: `master.key` in the data directory. */
export function masterKeyFile(): string {
  return path.join(dataDir(), KEY_FILE);
}

/** Where the master key comes from: KEELSON_DASHBOARD_KEY when it is set, the file in the data directory otherwise. */
export function keySource(): "environment" | "file" {
  return process.env.KEELSON_DASHBOARD_KEY ? "environment" : "file";
}

/** Whether the database already holds something encrypted with a master key (a stored credential, or the key check). */
function holdsEncryptedData(): boolean {
  const row = db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM key_check) + (SELECT COUNT(*) FROM servers) + (SELECT COUNT(*) FROM integrations)
         + (SELECT COUNT(*) FROM auth_factor WHERE totp_secret_enc IS NOT NULL) AS n`,
    )
    .get() as { n: number };
  return row.n > 0;
}

function readKeyFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The key in the data directory. When there is none, a new one is created, private to the owner (0600) and exclusively: a
 * second process that starts at the same moment reads the file the first one made instead of replacing it. But never when
 * the database already holds data encrypted with a key: a lost file would otherwise be silently replaced by a new key and
 * every stored credential would become unreadable.
 */
function fileMasterKey(): string {
  const file = masterKeyFile();
  let hex = readKeyFile(file);
  if (hex === null) {
    if (holdsEncryptedData()) {
      throw new Error(`${file} is missing, but this database holds data encrypted with the key that was in it: put the file back (your recovery file has the key) or set KEELSON_DASHBOARD_KEY`);
    }
    const fresh = randomBytes(32).toString("hex");
    try {
      writeFileSync(file, `${fresh}\n`, { flag: "wx", mode: 0o600 });
      console.log(`Keelson: created the master key in ${file}. Keep that directory, and save the recovery file the setup offers.`);
      hex = fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      hex = readKeyFile(file);
    }
  }
  if (hex === null || !KEY_HEX.test(hex)) throw new Error(`${file} must hold the master key: 64 hex characters`);
  return hex;
}

/** The 32-byte master key: 64 hex characters, from KEELSON_DASHBOARD_KEY or from the key file. */
function masterKey(): Buffer {
  const fromEnv = process.env.KEELSON_DASHBOARD_KEY;
  if (fromEnv && !KEY_HEX.test(fromEnv)) {
    throw new Error("KEELSON_DASHBOARD_KEY must be 64 hex characters (run `pnpm run generate-key`)");
  }
  return Buffer.from(fromEnv || fileMasterKey(), "hex");
}

/** The master key as hex, for the recovery file: only when it is the generated one (see keySource). */
export function generatedMasterKeyHex(): string {
  if (keySource() !== "file") throw new Error("the master key comes from KEELSON_DASHBOARD_KEY: it is not kept by the dashboard");
  return fileMasterKey().toLowerCase();
}

type KeyPurpose = "encryption" | "session";
const subkeys: Partial<Record<KeyPurpose, Buffer>> = {};

/** Derives an independent key per purpose from the master key. */
export function deriveKey(purpose: KeyPurpose): Buffer {
  const cached = subkeys[purpose];
  if (cached) return cached;
  const key = Buffer.from(hkdfSync("sha256", masterKey(), "keelson-dashboard", purpose, 32));
  subkeys[purpose] = key;
  return key;
}

// Only a found password is remembered: setup writes it once, and it cannot go back to missing. Remembering "none" would
// keep the proxy, which has its own copy of this module, in setup mode after the password was set.
let storedHash: string | undefined;

/** The hash set in the browser at first run, or null while none was. */
function storedPasswordHash(): string | null {
  if (storedHash === undefined) {
    const row = db().prepare("SELECT hash FROM admin_password WHERE id = 1").get() as { hash: string } | undefined;
    if (!row) return null;
    storedHash = row.hash;
  }
  return storedHash;
}

/** The operator's password hash, as produced by `pnpm run hash-password`, or null while neither it nor a stored one exists. */
function configuredPasswordHash(): string | null {
  return process.env.KEELSON_ADMIN_PASSWORD_HASH || storedPasswordHash();
}

/**
 * Setup mode: no password exists yet, neither in KEELSON_ADMIN_PASSWORD_HASH nor stored. Everything but the setup page is
 * closed until one is set. Once a password exists this is false for the life of the process, and costs no database read.
 */
export function setupRequired(): boolean {
  return configuredPasswordHash() === null;
}

/** The operator's password hash: KEELSON_ADMIN_PASSWORD_HASH when set, else the one stored by the setup. */
export function adminPasswordHash(): string {
  const hash = configuredPasswordHash();
  if (hash === null) throw new Error("no admin password is set: open /setup in the browser, or set KEELSON_ADMIN_PASSWORD_HASH (run `pnpm run hash-password`)");
  return hash;
}

/**
 * A short fingerprint of the password hash. Sessions carry it, so changing the
 * password invalidates every session issued before.
 */
export function passwordFingerprint(): string {
  return createHash("sha256").update(adminPasswordHash()).digest("hex").slice(0, 16);
}

/**
 * Whether the session cookie gets the Secure flag and HSTS is sent. Off only for plain-http local use: an https public address
 * always turns it on, whatever KEELSON_INSECURE_COOKIES says (deploy/compose.yaml sets that for its loopback default, and a
 * KEELSON_PUBLIC_URL added later in dashboard.env must not leave the cookies unprotected behind it).
 */
export function secureCookies(): boolean {
  if (/^https:\/\//i.test((process.env.KEELSON_PUBLIC_URL ?? "").trim())) return true;
  return process.env.KEELSON_INSECURE_COOKIES !== "true";
}

/** Whether X-Forwarded-For can be trusted to identify the client (behind a reverse proxy). */
export function trustProxy(): boolean {
  return process.env.KEELSON_TRUST_PROXY === "true";
}

/** The raw KEELSON_ALLOWED_IPS value (addresses and CIDR ranges), or null when any address may connect. */
export function allowedIpsSpec(): string | null {
  const raw = process.env.KEELSON_ALLOWED_IPS?.trim();
  return raw ? raw : null;
}

/** Whether signing in is refused until a second factor is set up (KEELSON_REQUIRE_2FA=true). */
export function requireSecondFactor(): boolean {
  return process.env.KEELSON_REQUIRE_2FA === "true";
}

/**
 * The address the dashboard is served at, such as https://keelson.example.com. Passkeys are bound to
 * its host name, so they are offered only when it is set. Returns null otherwise.
 */
export function publicUrl(): URL | null {
  const raw = process.env.KEELSON_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    throw new Error("KEELSON_PUBLIC_URL is not a valid URL");
  }
}

/**
 * How many reverse proxies sit in front of the dashboard, counted from the right of X-Forwarded-For: each one appends the
 * address it received the request from, so the client is the entry that many places from the end (1 = one proxy: the last
 * entry). Everything to the left of it is whatever the client wrote and is never used. Only read when KEELSON_TRUST_PROXY=true.
 */
export function trustedHops(): number {
  const raw = process.env.KEELSON_TRUSTED_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number(raw);
  if (!/^\d+$/.test(raw) || hops < 1 || hops > 10) throw new Error("KEELSON_TRUSTED_HOPS must be a whole number from 1 to 10: the number of reverse proxies in front of the dashboard");
  return hops;
}

/**
 * The request header that carries the client's address, set by a proxy you trust (CF-Connecting-IP behind Cloudflare, X-Real-IP
 * behind nginx). When set it wins over X-Forwarded-For, and it is used even without KEELSON_TRUST_PROXY: naming it is the trust.
 * Null when not set.
 */
export function clientIpHeader(): string | null {
  const raw = process.env.KEELSON_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9-]+$/.test(raw)) throw new Error("KEELSON_CLIENT_IP_HEADER must be a header name such as CF-Connecting-IP");
  return raw;
}

/** Where the dashboard looks for its newest release. */
export const RELEASE_CHECK_URL = "https://api.github.com/repos/0x2u/keelson/releases/latest";

/**
 * Whether the dashboard may ask GitHub which release is the latest (once a day, to tell the operator an update exists). On unless
 * KEELSON_UPDATE_CHECK is off (or false, 0): then no outbound call of this feature is ever made.
 */
export function updateCheckEnabled(): boolean {
  return !["off", "false", "0"].includes(process.env.KEELSON_UPDATE_CHECK?.trim().toLowerCase() ?? "");
}

/** The address the check reads: KEELSON_UPDATE_CHECK_URL (for tests and development only) or GitHub's. */
export function updateCheckUrl(): string {
  return process.env.KEELSON_UPDATE_CHECK_URL?.trim() || RELEASE_CHECK_URL;
}
