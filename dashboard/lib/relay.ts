import "server-only";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { createRelayServer, getServer, markSeen, serverByCredentialHash, type ServerSummary } from "@/lib/servers";
import {
  RELAY_CODE_TTL_MS,
  RELAY_FEATURE_REQUEST_STREAM,
  RELAY_MAX_IN_FLIGHT,
  RELAY_MAX_REQUEST_BYTES,
  RELAY_MAX_STREAM_BYTES,
  RELAY_PING_EVERY_S,
  encodeConnection,
  sha256Hex,
  type EnrolRequest,
} from "@/lib/relay-core";

// A machine that connects out to the dashboard keeps one NDJSON stream open (the "connection"): the dashboard writes the
// requests it would have sent to an agent's URL onto it, and the machine answers each with sequential POSTs to
// /api/relay/response/<id> (the "chunks"), which become the body of a streaming Response here. A request body too large
// for a line (an image archive) is not written onto it: the request says `stream: true` and the machine, which announced
// it can in `X-Relay-Features`, reads the body with GET /api/relay/request/<id>/body. Nothing about an in-flight request
// is persisted. The wire format is in the relay contract; this file is the dashboard's side of it.

/** A failure of the relay itself. `status` follows AgentError: 0 = the machine could not be reached. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

const NOT_CONNECTED = "the agent on this server is not connected to the dashboard";
/** How long the id of a finished request keeps answering 410/409 instead of 404 (the machine may still be sending). */
const FINISHED_KEEP_MS = 60_000;
/** The answers with no body: what the machine sends for them is thrown away. */
const BODYLESS = new Set([204, 205, 304]);
/** What a request that needs the streamed body says to a machine that cannot receive it. */
const CANNOT_STREAM = "update the agent on this server: it cannot receive an image over the relay yet";
/** Why a body that nobody will read is cancelled. */
const REQUEST_OVER = "the request is over";

interface Connection {
  serverId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  ping: ReturnType<typeof setInterval>;
  open: boolean;
  /** What the machine said it can do when it connected. */
  features: ReadonlySet<string>;
  connectedAt: number;
  requests: Set<Pending>;
}

interface Hub {
  connections: Map<string, Connection>;
  pending: Map<string, Pending>;
  /** Requests that are over, oldest first, so the machine learns why its next chunk is refused. */
  finished: Map<string, { serverId: string; gone: boolean; until: number }>;
  seen: Map<string, number>;
}

// One hub per process: route handlers and server code may be bundled separately, and dev reloads re-evaluate modules.
const holder = globalThis as unknown as { keelsonRelay?: Hub };

function hub(): Hub {
  return (holder.keelsonRelay ??= { connections: new Map(), pending: new Map(), finished: new Map(), seen: new Map() });
}

const encoder = new TextEncoder();

function send(conn: Connection, line: object): void {
  try {
    conn.controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
  } catch {
    /* the stream is already closed: the connection is being torn down */
  }
}

/** Notes that the machine is alive: in memory always, in the database for the pages that read servers.last_seen_at. */
function touch(serverId: string, persist: boolean): void {
  const now = Date.now();
  hub().seen.set(serverId, now);
  if (persist) markSeen(serverId, now);
}

export function relayStatus(serverId: string): { connected: boolean; lastSeen: number | null; features: string[] } {
  const h = hub();
  const conn = h.connections.get(serverId);
  return { connected: conn !== undefined, lastSeen: h.seen.get(serverId) ?? null, features: [...(conn?.features ?? [])].sort() };
}

/** When the machine's present connection was made (ms), or null while it is not connected: a restarted agent connects again, so this moves. */
export function relayConnectedAt(serverId: string): number | null {
  return hub().connections.get(serverId)?.connectedAt ?? null;
}

// ---- Connections --------------------------------------------------------------------------------------------------

/** Ends a connection (once) and fails what was in flight on it. */
function closeConnection(conn: Connection, why: RelayError): void {
  if (!conn.open) return;
  conn.open = false;
  clearInterval(conn.ping);
  const h = hub();
  if (h.connections.get(conn.serverId) === conn) h.connections.delete(conn.serverId);
  for (const p of [...conn.requests]) p.fail(why);
  try {
    conn.controller.close();
  } catch {
    /* already cancelled by the client */
  }
  touch(conn.serverId, true);
}

/**
 * Registers the connection of a machine, which announced `features`, and returns the stream to give it; it ends with
 * `signal` (the client went away). A connection that exists already is replaced: it is told so and closed, and its
 * requests fail.
 */
export function openRelayConnection(serverId: string, signal: AbortSignal, features: ReadonlySet<string>): ReadableStream<Uint8Array> {
  const h = hub();
  const old = h.connections.get(serverId);
  if (old) {
    send(old, { type: "replaced" });
    closeConnection(old, new RelayError(502, "the machine connected again from somewhere else, so this request was dropped"));
  }
  const conn = { serverId, features, open: true, connectedAt: Date.now(), requests: new Set<Pending>() } as Connection;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      conn.controller = controller;
    },
    cancel() {
      closeConnection(conn, new RelayError(0, "the connection to this machine was lost"));
    },
  });
  h.connections.set(serverId, conn);
  send(conn, { type: "hello", server_id: serverId, ping_every: RELAY_PING_EVERY_S });
  conn.ping = setInterval(() => {
    try {
      // Removing a server cuts its connection here: the machine reconnects, is refused, and stops.
      if (!getServer(serverId)) {
        closeConnection(conn, new RelayError(0, "this machine was removed from the dashboard"));
        return;
      }
      send(conn, { type: "ping" });
      touch(serverId, true);
    } catch {
      closeConnection(conn, new RelayError(0, "the connection to this machine failed"));
    }
  }, RELAY_PING_EVERY_S * 1000);
  conn.ping.unref();
  signal.addEventListener("abort", () => closeConnection(conn, new RelayError(0, "the connection to this machine was lost")), { once: true });
  touch(serverId, true);
  return stream;
}

// ---- Requests -----------------------------------------------------------------------------------------------------

export interface RelayRequest {
  method: string;
  /** With the query. */
  path: string;
  headers: Record<string, string>;
  /** Sent in the line: at most 1 MiB. Not together with `stream`. */
  body?: string;
  /**
   * A body too large for a line (an image archive), which the machine reads itself, at its own pace: at most 8 GiB.
   * relayFetch owns it from the call on: it is cancelled when the request ends or fails, whichever way.
   */
  stream?: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  /** Giving up (a timeout, a navigation): before the head it rejects with the signal's reason, after it the body errors. */
  signal?: AbortSignal;
}

/** A web stream over what the caller gave: a Node stream is wrapped, a web stream is used as it is. */
function webStream(source: ReadableStream<Uint8Array> | NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  if ("getReader" in source) return source;
  // node:stream/web and the DOM declare the same stream with different types.
  return Readable.toWeb(source instanceof Readable ? source : new Readable().wrap(source)) as unknown as ReadableStream<Uint8Array>;
}

/**
 * The body of a request that does not fit in a line of the connection (an image archive): the machine fetches it
 * itself, once, with GET /api/relay/request/<id>/body. The source is read only as fast as the machine takes it (the
 * response of that GET pulls from it, and the network pushes back), so the body is never in memory as a whole; it is
 * cancelled as soon as the request is over, whoever ends it.
 */
class Upload {
  /** The machine asked for it: it is not given twice. */
  taken = false;
  private sent = 0;
  private destroyed = false;
  private out: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(source: ReadableStream<Uint8Array> | NodeJS.ReadableStream) {
    this.reader = webStream(source).getReader();
  }

  /**
   * The body as the answer to the machine's GET. `tooLarge` runs when the source is longer than the limit; `lost`
   * aborts when the machine's GET ends (its connection dropped).
   */
  stream(tooLarge: () => void, lost: AbortSignal): ReadableStream<Uint8Array> {
    this.taken = true;
    const out = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.out = controller;
      },
      pull: async (controller) => {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await this.reader.read();
        } catch (err) {
          this.destroy(err);
          return;
        }
        if (this.destroyed) return;
        if (read.done) {
          controller.close();
          return;
        }
        this.sent += read.value.byteLength;
        if (this.sent > RELAY_MAX_STREAM_BYTES) tooLarge();
        else controller.enqueue(read.value);
      },
      cancel: (reason) => this.destroy(reason),
    });
    if (lost.aborted) this.destroy(lost.reason);
    else lost.addEventListener("abort", () => this.destroy(lost.reason), { once: true });
    return out;
  }

  /** Nobody will read the rest: the source is cancelled, and what the machine still receives of it fails. */
  destroy(reason: unknown = new RelayError(0, REQUEST_OVER)): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.out?.error(reason);
    this.reader.cancel(reason).catch(() => {});
  }
}

/** One request in flight: the answer's body as a stream that the machine's chunks feed, one at a time. */
class Pending {
  nextSeq = 0;
  private headSettled = false;
  private live = true;
  /** The chunk POST held back until the consumer has room: 200 = go on, 410 = nobody waits any more. */
  private room: ((answer: 200 | 410) => void) | null = null;
  private discard = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly stream: ReadableStream<Uint8Array>;
  private readonly onAbort = (): void => {
    this.tellCancel();
    this.fail(this.signal?.reason);
  };

  constructor(
    readonly id: string,
    readonly connection: Connection,
    private readonly resolveHead: (res: Response) => void,
    private readonly rejectHead: (err: unknown) => void,
    private readonly signal: AbortSignal | undefined,
    private readonly upload: Upload | undefined,
  ) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        // The consumer asked for more, so the chunk that was held back may be answered.
        pull: () => this.wake(200),
        // The consumer went away: the machine is told to stop.
        cancel: () => {
          if (!this.live) return;
          this.tellCancel();
          this.release(true);
        },
      },
      new CountQueuingStrategy({ highWaterMark: 2 }),
    );
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private wake(answer: 200 | 410): void {
    const room = this.room;
    this.room = null;
    room?.(answer);
  }

  private tellCancel(): void {
    if (this.connection.open) send(this.connection, { type: "cancel", id: this.id });
  }

  /** The id leaves the tables: from now on the machine's chunks for it are refused, with the reason. */
  private release(gone: boolean): void {
    this.live = false;
    this.signal?.removeEventListener("abort", this.onAbort);
    const h = hub();
    h.pending.delete(this.id);
    this.connection.requests.delete(this);
    const now = Date.now();
    for (const [id, f] of h.finished) {
      if (f.until > now) break;
      h.finished.delete(id);
    }
    h.finished.set(this.id, { serverId: this.connection.serverId, gone, until: now + FINISHED_KEEP_MS });
    this.upload?.destroy();
    this.wake(gone ? 410 : 200);
  }

  /** The request failed from outside (connection lost, caller gave up): whoever waits for it hears `err`. */
  fail(err: unknown): void {
    if (!this.live) return;
    this.release(true);
    if (this.headSettled) this.controller.error(err);
    else this.rejectHead(err);
  }

  /** The machine asks for the request's body: once, and only a request that has one. */
  takeBody(lost: AbortSignal): { status: 200; body: ReadableStream<Uint8Array> } | { status: 404 | 409 } {
    if (!this.upload) return { status: 404 };
    if (this.upload.taken) return { status: 409 };
    return { status: 200, body: this.upload.stream(() => this.fail(new RelayError(413, "a request body streamed to a machine that connected out may not exceed 8 GiB")), lost) };
  }

  /** The machine sent status and headers: the caller gets its Response. */
  answer(status: number, headers: Headers): void {
    this.headSettled = true;
    this.discard = BODYLESS.has(status);
    this.resolveHead(new Response(this.discard ? null : this.stream, { status, headers }));
  }

  /** A chunk's POST is held back: the machine must not send another before it is answered. */
  get holding(): boolean {
    return this.room !== null;
  }

  /**
   * Takes the machine's next chunk. Resolves 200 once the consumer has room for more (so a slow consumer slows the
   * machine down to its pace), 410 when nobody waits any more.
   */
  take(data: Uint8Array, end: boolean): Promise<200 | 410> {
    if (data.byteLength > 0 && !this.discard) this.controller.enqueue(data);
    if (end) {
      this.release(false);
      this.controller.close();
      return Promise.resolve(200);
    }
    // Up to two chunks sit in the stream: this one is answered once the one before it has been taken.
    if (data.byteLength === 0 || this.discard || (this.controller.desiredSize ?? 0) > 0) return Promise.resolve(200);
    return new Promise((resolve) => {
      this.room = resolve;
    });
  }
}

/**
 * Sends a request to a machine and resolves with its answer as soon as the machine has sent the status and headers; the
 * body then streams in as the machine sends chunks, held back while the consumer has not taken the previous one.
 * Throws RelayError (not connected: 0, too many in flight: 429, body too large: 413, a stream to a machine that cannot
 * receive one: 400, connection lost: 0 or 502). A `stream` is cancelled whenever the request fails or ends.
 */
export async function relayFetch(serverId: string, req: RelayRequest): Promise<Response> {
  if (req.body !== undefined && req.stream !== undefined) throw new TypeError("a relay request has a body or a stream, never both");
  const upload = req.stream === undefined ? undefined : new Upload(req.stream);
  try {
    const conn = hub().connections.get(serverId);
    if (req.body !== undefined && Buffer.byteLength(req.body) > RELAY_MAX_REQUEST_BYTES) {
      throw new RelayError(413, "a request to a machine that connected out may not exceed 1 MiB");
    }
    if (!conn) throw new RelayError(0, NOT_CONNECTED);
    if (upload && !conn.features.has(RELAY_FEATURE_REQUEST_STREAM)) throw new RelayError(400, CANNOT_STREAM);
    if (conn.requests.size >= RELAY_MAX_IN_FLIGHT) throw new RelayError(429, "too many requests in flight to this machine");
    req.signal?.throwIfAborted();

    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const id = randomBytes(8).toString("hex");
    const pending = new Pending(id, conn, resolve, reject, req.signal, upload);
    hub().pending.set(id, pending);
    conn.requests.add(pending);
    send(conn, {
      type: "request",
      id,
      method: req.method,
      path: req.path,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: Buffer.from(req.body).toString("base64") }),
      ...(upload ? { stream: true } : {}),
    });
    return promise;
  } catch (err) {
    upload?.destroy(err);
    throw err;
  }
}

export interface Chunk {
  seq: number;
  /** Seq 0 only. */
  head?: { status: number; headers: Headers };
  end: boolean;
  data: Uint8Array;
}

/**
 * The machine's answer to one chunk POST for request `id`: 200 accepted, 404 not a request of this machine, 409 out of
 * sequence or already over, 410 nobody waits any more. Held back (not answered) while the consumer is slow.
 */
export function acceptChunk(serverId: string, id: string, chunk: Chunk): Promise<200 | 404 | 409 | 410> {
  const h = hub();
  const p = h.pending.get(id);
  if (!p || p.connection.serverId !== serverId) {
    const f = h.finished.get(id);
    if (f?.serverId !== serverId) return Promise.resolve(404);
    return Promise.resolve(f.gone ? 410 : 409);
  }
  // Chunk n+1 only after chunk n was answered: a machine that sends them in parallel would fill memory past the backpressure.
  if (p.holding || chunk.seq !== p.nextSeq || (chunk.seq === 0) !== (chunk.head !== undefined)) return Promise.resolve(409);
  p.nextSeq++;
  touch(serverId, false);
  if (chunk.head) p.answer(chunk.head.status, chunk.head.headers);
  return p.take(chunk.data, chunk.end);
}

/**
 * The machine asks for the body of request `id` (GET /api/relay/request/<id>/body): the stream, once. 404: not a streamed
 * request of this machine; 409: its body was taken already; 410: the request is over. `lost` aborts when the machine's
 * GET ends before the body did: the rest is not read from the source.
 */
export function takeRequestBody(serverId: string, id: string, lost: AbortSignal): { status: 200; body: ReadableStream<Uint8Array> } | { status: 404 | 409 | 410 } {
  const h = hub();
  const p = h.pending.get(id);
  if (!p || p.connection.serverId !== serverId) return { status: h.finished.get(id)?.serverId === serverId ? 410 : 404 };
  touch(serverId, false);
  return p.takeBody(lost);
}

/** The machine sent an answer that makes no sense: its request fails now rather than at the caller's timeout. */
export function failRequest(serverId: string, id: string, message: string): void {
  const p = hub().pending.get(id);
  if (p?.connection.serverId === serverId) p.fail(new RelayError(502, message));
}

// ---- Credentials and enrolment codes ------------------------------------------------------------------------------

/** The machine whose credential the request carries (`Authorization: Bearer`), or null: unknown, or removed since. */
export function relayMachine(request: Request): ServerSummary | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match ? serverByCredentialHash(sha256Hex(match[1])) : null;
}

/** A day after a code stopped being usable its row goes. */
const CODE_KEEP_MS = 24 * 3_600_000;

export type RelayCodeKind = "enrol" | "upgrade";

/**
 * Makes a code, and stores only its hash. `origin` is this dashboard's URL as the machine will reach it. An `enrol` code
 * (the default) makes a server of the machine that spends it. An `upgrade` code is for one existing server, `serverId`: it
 * only lets that server download the agent to replace its own, and enrols nothing.
 */
export function createRelayCode(origin: string, kind: RelayCodeKind = "enrol", serverId: string | null = null): { code: string; connection: string; expiresAt: number } {
  if (kind === "upgrade" && !serverId) throw new Error("an upgrade code is made for a server");
  const code = randomBytes(24).toString("base64url");
  const now = Date.now();
  const expiresAt = now + RELAY_CODE_TTL_MS;
  db().prepare("DELETE FROM relay_codes WHERE expires_at < ? OR used_at < ?").run(now - CODE_KEEP_MS, now - CODE_KEEP_MS);
  db()
    .prepare("INSERT INTO relay_codes (code_hash, created_at, expires_at, kind, server_id) VALUES (?, ?, ?, ?, ?)")
    .run(sha256Hex(code), now, expiresAt, kind, kind === "upgrade" ? serverId : null);
  return { code, connection: encodeConnection(origin, code), expiresAt };
}

/** Whether the code exists, has not expired and has not been used (of whatever kind: see `relayCodeAllowsBinary` and `consumeRelayCode` for what each may do). */
export function relayCodeValid(code: string): boolean {
  return db().prepare("SELECT 1 FROM relay_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256Hex(code), Date.now()) !== undefined;
}

/**
 * Whether the code may fetch the agent binary: an enrolment code (the machine downloads the agent, then enrols), or an upgrade
 * code whose server still exists. This is all an upgrade code can do.
 */
export function relayCodeAllowsBinary(code: string): boolean {
  const row = db().prepare("SELECT kind, server_id FROM relay_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256Hex(code), Date.now()) as
    | { kind: string; server_id: string | null }
    | undefined;
  if (!row) return false;
  if (row.kind === "enrol") return true;
  return row.kind === "upgrade" && row.server_id !== null && getServer(row.server_id) !== null;
}

/** Spends an enrolment code: true for exactly one caller, however many try at once. An upgrade code is never spent by an enrolment. */
export function consumeRelayCode(code: string): boolean {
  const now = Date.now();
  const spent = db().prepare("UPDATE relay_codes SET used_at = ? WHERE code_hash = ? AND kind = 'enrol' AND used_at IS NULL AND expires_at > ?").run(now, sha256Hex(code), now);
  return Number(spent.changes) > 0;
}

/**
 * Enrols a machine: spends the code and registers the server together, so a failure to register leaves the code
 * usable. Null for a code that is unknown, used or expired. The credential is returned once; only its hash is kept.
 */
export function enrolRelayMachine(req: EnrolRequest): { credential: string; serverId: string; name: string } | null {
  const credential = randomBytes(32).toString("base64url");
  db().exec("BEGIN IMMEDIATE");
  try {
    if (!consumeRelayCode(req.code)) {
      db().exec("ROLLBACK");
      return null;
    }
    const server = createRelayServer({ name: req.name, token: req.token, deploySecret: req.deploySecret, credentialHash: sha256Hex(credential), serves: req.serves });
    db().exec("COMMIT");
    return { credential, serverId: server.id, name: server.name };
  } catch (err) {
    db().exec("ROLLBACK");
    throw err;
  }
}
