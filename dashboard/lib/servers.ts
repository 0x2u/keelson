import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { SERVER_NAME_MAX, normalizeUrl } from "@/lib/server-input";

/** A server as shown in the UI: never carries a secret. */
export interface ServerSummary {
  id: string;
  name: string;
  /** Empty for a relay server: nothing can reach it, it connects out to this dashboard. */
  url: string;
  /** "relay" = a machine that connects out to this dashboard (no address, no certificates). */
  transport: "direct" | "relay";
  /**
   * A relay server that was installed as a full agent: it runs apps like a direct server. False for a build machine (a laptop
   * that builds images and serves nothing) and for every direct server (they always run apps: see `canRunApps`).
   */
  serves: boolean;
  /** The agent was given a deploy secret, so deploy and rollback are offered. */
  canDeploy: boolean;
  caCert: string | null;
  clientCert: string | null;
  hasClientKey: boolean;
  /** The address domains of this server must point at, when it was set explicitly; null = derived from the agent's URL. */
  publicIp: string | null;
  /** The domain new projects get a host name under (`<project>.<appsDomain>`); null = none set. */
  appsDomain: string | null;
  createdAt: number;
}

/** A server with everything needed to talk to its agent. Server-side only. */
export interface ServerCredentials extends ServerSummary {
  token: string;
  deploySecret: string | null;
  clientKey: string | null;
  updatedAt: number;
  /**
   * The stored credentials could not be decrypted: the master key is not the one they were written with. The secrets above are
   * then empty (every call to the agent is refused as unauthorised, which says so), and the server can still be removed and
   * added again. One server in that state must not take Home and the other servers down with it.
   */
  unreadable?: boolean;
}

export interface ServerCreate {
  name: string;
  url: string;
  token: string;
  deploySecret?: string;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  publicIp?: string;
}

export interface ServerUpdate {
  name: string;
  url: string;
  /** Empty or undefined keeps the stored value, for every secret below. */
  token?: string;
  deploySecret?: string;
  removeDeploySecret?: boolean;
  caCert: string;
  clientCert: string;
  clientKey?: string;
  /** Undefined keeps the stored address; empty clears it (the address is derived from the agent's URL again). */
  publicIp?: string;
}

interface Row {
  id: string;
  name: string;
  url: string;
  transport: "direct" | "relay";
  serves: number;
  token_enc: string;
  deploy_secret_enc: string | null;
  ca_cert: string | null;
  client_cert: string | null;
  client_key_enc: string | null;
  public_ip: string | null;
  apps_domain: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, name, url, transport, serves, token_enc, deploy_secret_enc, ca_cert, client_cert, client_key_enc, public_ip, apps_domain, created_at, updated_at";

function toSummary(r: Row): ServerSummary {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    transport: r.transport,
    serves: r.serves === 1,
    canDeploy: r.deploy_secret_enc !== null,
    caCert: r.ca_cert,
    clientCert: r.client_cert,
    hasClientKey: r.client_key_enc !== null,
    publicIp: r.public_ip,
    appsDomain: r.apps_domain,
    createdAt: r.created_at,
  };
}

function toCredentials(r: Row): ServerCredentials {
  try {
    return {
      ...toSummary(r),
      token: decrypt(r.token_enc),
      deploySecret: r.deploy_secret_enc === null ? null : decrypt(r.deploy_secret_enc),
      clientKey: r.client_key_enc === null ? null : decrypt(r.client_key_enc),
      updatedAt: r.updated_at,
    };
  } catch {
    return { ...toSummary(r), token: "", deploySecret: null, clientKey: null, updatedAt: r.updated_at, unreadable: true };
  }
}

/** Empty strings become NULL so "no value" has one representation. */
const orNull = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

function requireUrl(raw: string): string {
  const url = normalizeUrl(raw);
  if (url === null) throw new Error("invalid server URL");
  return url;
}

export class DuplicateServerError extends Error {
  constructor() {
    super("a server with this name already exists");
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export function listServers(): ServerSummary[] {
  return (db().prepare(`SELECT ${COLUMNS} FROM servers ORDER BY name`).all() as unknown as Row[]).map(toSummary);
}

export function getServer(id: string): ServerSummary | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).get(id) as unknown as Row | undefined;
  return row ? toSummary(row) : null;
}

export function getCredentials(id: string): ServerCredentials | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).get(id) as unknown as Row | undefined;
  return row ? toCredentials(row) : null;
}

export function createServer(input: ServerCreate): string {
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  try {
    db()
      .prepare(
        `INSERT INTO servers (id, name, url, token_enc, deploy_secret_enc, ca_cert, client_cert, client_key_enc, public_ip, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        requireUrl(input.url),
        encrypt(input.token),
        orNull(input.deploySecret) === null ? null : encrypt(input.deploySecret!.trim()),
        orNull(input.caCert),
        orNull(input.clientCert),
        orNull(input.clientKey) === null ? null : encrypt(input.clientKey!.trim()),
        orNull(input.publicIp),
        now,
        now,
      );
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateServerError();
    throw err;
  }
  return id;
}

export interface RelayServerCreate {
  name: string;
  token: string;
  deploySecret: string;
  /** SHA-256 (hex) of the credential the machine presents when it connects. */
  credentialHash: string;
  /** A full agent that runs apps (the one-command install), not a build machine. */
  serves: boolean;
}

/**
 * Registers a machine that connects out to the dashboard. A name that is taken gets a numeric suffix ("mac", "mac-2"):
 * the machine chose it itself, so refusing would leave it unable to enrol.
 */
export function createRelayServer(input: RelayServerCreate): { id: string; name: string } {
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  const base = input.name.trim();
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base.slice(0, SERVER_NAME_MAX - String(n).length - 1)}-${n}`;
    try {
      db()
        .prepare(
          `INSERT INTO servers (id, name, url, transport, serves, token_enc, deploy_secret_enc, relay_credential_hash, created_at, updated_at)
           VALUES (?, ?, '', 'relay', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, input.serves ? 1 : 0, encrypt(input.token), encrypt(input.deploySecret), input.credentialHash, now, now);
      return { id, name };
    } catch (err) {
      if (!isUniqueViolation(err) || !/servers\.name/.test((err as Error).message)) throw err;
    }
  }
}

/** The relay server that presents this credential (by its SHA-256), or null when none does (it was removed). */
export function serverByCredentialHash(hash: string): ServerSummary | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM servers WHERE relay_credential_hash = ?`).get(hash) as unknown as Row | undefined;
  return row ? toSummary(row) : null;
}

export function updateServer(id: string, input: ServerUpdate): boolean {
  const row = db().prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).get(id) as unknown as Row | undefined;
  if (!row) return false;

  // A machine that connects out has no address and no certificates: whatever a form sends for them is ignored.
  const relay = row.transport === "relay";
  const clientCert = relay ? null : orNull(input.clientCert);
  const newKey = orNull(input.clientKey);
  const deploySecretEnc = input.removeDeploySecret
    ? null
    : orNull(input.deploySecret) !== null
      ? encrypt(input.deploySecret!.trim())
      : row.deploy_secret_enc;

  try {
    db()
      .prepare(
        `UPDATE servers SET name = ?, url = ?, token_enc = ?, deploy_secret_enc = ?, ca_cert = ?,
           client_cert = ?, client_key_enc = ?, public_ip = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name.trim(),
        relay ? "" : requireUrl(input.url),
        orNull(input.token) === null ? row.token_enc : encrypt(input.token!),
        deploySecretEnc,
        relay ? null : orNull(input.caCert),
        clientCert,
        // Without a client certificate a stored key has no use: drop it.
        clientCert === null ? null : newKey === null ? row.client_key_enc : encrypt(newKey),
        input.publicIp === undefined ? row.public_ip : orNull(input.publicIp),
        Date.now(),
        id,
      );
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateServerError();
    throw err;
  }
  return true;
}

export function deleteServer(id: string): boolean {
  return Number(db().prepare("DELETE FROM servers WHERE id = ?").run(id).changes) > 0;
}

/** Records that the agent answered just now (milliseconds). Never moves backwards, whatever order requests finish in. */
export function markSeen(id: string, at: number = Date.now()): void {
  db().prepare("UPDATE servers SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)").run(at, id, at);
}

/** Sets (or, with null, clears) the domain this server's new projects get a host name under. False for an unknown server. */
export function setAppsDomain(id: string, domain: string | null): boolean {
  return Number(db().prepare("UPDATE servers SET apps_domain = ?, updated_at = ? WHERE id = ?").run(domain, Date.now(), id).changes) > 0;
}

/** Sets (or, with null, clears) the address this server's domains must point at. False for an unknown server. */
export function setPublicIp(id: string, ip: string | null): boolean {
  return Number(db().prepare("UPDATE servers SET public_ip = ?, updated_at = ? WHERE id = ?").run(ip, Date.now(), id).changes) > 0;
}

/** When the agent last answered this dashboard (milliseconds), or null if it never has. */
export function lastSeen(id: string): number | null {
  const row = db().prepare("SELECT last_seen_at FROM servers WHERE id = ?").get(id) as { last_seen_at: number | null } | undefined;
  return row?.last_seen_at ?? null;
}
