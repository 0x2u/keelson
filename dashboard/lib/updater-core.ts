// One-click update of the dashboard itself. The dashboard never touches Docker: it drops a request file into a directory it
// shares with the host (mounted at /run/keelson), and a unit on the host that `install.sh` set up does the work (copies the
// database, pulls the images, restarts, and puts the old version back if the new one is not healthy), reporting in a status
// file. Both files are read here as untrusted: the directory is shared, whatever is in it is only believed after checking.

export const MARKER_FILE = "updater.json";
export const REQUEST_FILE = "update-request.json";
export const STATUS_FILE = "update-status.json";

/** The one shape of version an update may name: a final release tag. Numbers are capped so they stay exact integers. */
const PLAIN_TAG = /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** A request nobody picked up for this long is stale (the host's unit is down); a run that reported nothing for this long is dead. */
export const REQUEST_STALE_MS = 30 * 60 * 1000;
export const RUN_STALE_MS = 30 * 60 * 1000;

const MESSAGE_MAX = 300;
const VERSION_MAX = 64;

/** `[major, minor, patch]` of a plain `vX.Y.Z` tag (leading zeros allowed, as the host allows them), or null for anything else. */
export function plainVersion(text: string): [number, number, number] | null {
  if (!PLAIN_TAG.test(text)) return null;
  const [major, minor, patch] = text.slice(1).split(".").map(Number);
  return [major, minor, patch];
}

/** -1, 0 or 1 by numeric precedence per component; null when either side is not a plain `vX.Y.Z` tag. */
export function comparePlain(a: string, b: string): -1 | 0 | 1 | null {
  const [x, y] = [plainVersion(a), plainVersion(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Whether `candidate` is a plain release strictly newer than the plain release `running`. */
export function isNewerPlain(candidate: string, running: string): boolean {
  return comparePlain(running, candidate) === -1;
}

/** Whether updater.json says the host side is installed: `{"version":1,"installed":true}`. */
export function parseMarker(text: string | null): boolean {
  if (text === null) return false;
  const o = parseObject(text);
  return o !== null && o.version === 1 && o.installed === true;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The request file's exact content. The host reads only `version`; `requested_at` is for people and for `pendingRequest`. */
export function buildRequest(version: string, now: Date): string {
  return JSON.stringify({ version, requested_at: now.toISOString() });
}

export type UpdateState = "running" | "done" | "failed" | "rolled_back";
export type UpdatePhase = "validating" | "downloading" | "backup" | "pulling" | "starting" | "rolling-back" | "done";

const STATES: readonly string[] = ["running", "done", "failed", "rolled_back"] satisfies UpdateState[];
const PHASES: readonly string[] = ["validating", "downloading", "backup", "pulling", "starting", "rolling-back", "done"] satisfies UpdatePhase[];

/** What the host reports about a run, checked and with times in ms since the epoch. */
export interface UpdateStatus {
  state: UpdateState;
  phase: UpdatePhase;
  from: string;
  to: string;
  message: string;
  startedAt: number;
  finishedAt: number | null;
}

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MESSAGE_MAX);
}

function time(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** update-status.json as the host writes it, or null when it is not that (missing, garbage, a shape that does not fit): then there is no status. */
export function parseStatus(text: string | null): UpdateStatus | null {
  if (text === null) return null;
  const o = parseObject(text);
  if (!o) return null;
  const { state, phase, from, to, message, started_at: started, finished_at: finished } = o;
  if (typeof state !== "string" || !STATES.includes(state) || typeof phase !== "string" || !PHASES.includes(phase)) return null;
  if (typeof from !== "string" || from.length === 0 || from.length > VERSION_MAX || typeof to !== "string" || !PLAIN_TAG.test(to)) return null;
  if (typeof message !== "string") return null;
  const startedAt = time(started);
  if (startedAt === null) return null;
  const finishedAt = finished === "" || finished === undefined || finished === null ? null : time(finished);
  if (finished !== "" && finished !== undefined && finished !== null && finishedAt === null) return null;
  return { state: state as UpdateState, phase: phase as UpdatePhase, from: clean(from), to, message: clean(message), startedAt, finishedAt };
}

/** Whether a request file is waiting for the host: present, readable, and made recently. A stale or garbled one does not block a new request. */
export function pendingRequest(text: string | null, now: number): boolean {
  if (text === null) return false;
  const at = time(parseObject(text)?.requested_at);
  return at !== null && now - at < REQUEST_STALE_MS && at - now < REQUEST_STALE_MS;
}

/** What the status route answers, and what the client reads. */
export interface UpdatePayload {
  /** The one-click update is available: the host side is installed and the update check is on. */
  updater: boolean;
  /** The version this dashboard runs. */
  version: string;
  status: UpdateStatus | null;
  /** A request waits for the host to start. */
  requested: boolean;
}

export function updatePayload(input: { updater: boolean; version: string; statusText: string | null; requestText: string | null; now: number }): UpdatePayload {
  return { updater: input.updater, version: input.version, status: parseStatus(input.statusText), requested: pendingRequest(input.requestText, input.now) };
}

/** A run is in progress: the host reports one that is alive, or a request waits. */
export function busy(payload: Pick<UpdatePayload, "status" | "requested">, now: number): boolean {
  const s = payload.status;
  return payload.requested || (s !== null && s.state === "running" && now - s.startedAt < RUN_STALE_MS);
}

export type RequestCheck = { ok: true; version: string } | { ok: false; error: string };

/**
 * Whether an update to `version` may be requested. Only the release this dashboard itself knows as the latest qualifies
 * (`latest`, from the cached release check), and only a plain `vX.Y.Z` strictly newer than the running one: a build between
 * tags or a pre-release is never replaced from here. The host checks again; this refuses early, with a reason a person can read.
 */
export function checkRequest(input: { version: unknown; running: string; latest: string | null; payload: UpdatePayload; now: number }): RequestCheck {
  const { version, running, latest, payload, now } = input;
  if (!payload.updater) return { ok: false, error: "The one-click update is not set up on this host. Run the install command once, as the update notice says." };
  if (typeof version !== "string" || !PLAIN_TAG.test(version)) return { ok: false, error: "That is not a release version (vX.Y.Z)." };
  if (!PLAIN_TAG.test(running)) return { ok: false, error: `This dashboard runs ${running}, which is not a release: it cannot be updated from here.` };
  if (!isNewerPlain(version, running)) return { ok: false, error: `${version} is not newer than the running ${running}.` };
  if (latest === null) return { ok: false, error: "The latest release is not known: use Check now first." };
  if (version !== latest) return { ok: false, error: `The latest release is ${latest}, not ${version}. Use Check now and try again.` };
  if (busy(payload, now)) return { ok: false, error: "An update is already in progress." };
  return { ok: true, version };
}

/** Whether the Update button is offered: the check found a plain release newer than the running plain one, and the host side is there. */
export function offersOneClick(input: { running: string; latest: string | null; updater: boolean }): boolean {
  return input.updater && input.latest !== null && PLAIN_TAG.test(input.running) && isNewerPlain(input.latest, input.running);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the operator sees after the click.

export type UpdateViewKind = "waiting" | "running" | "restarting" | "done" | "failed" | "rolled_back" | "stalled";

export interface UpdateView {
  kind: UpdateViewKind;
  text: string;
  /** Poll again. */
  polling: boolean;
}

/** After this long without an answer that settles the run, the client stops and says so. */
export const STALL_MS = 15 * 60 * 1000;
/** The host writes second-resolution times: its `started_at` may be a moment before the request's own. */
const START_TOLERANCE_MS = 5000;

const PHASE_TEXT: Record<UpdatePhase, (to: string) => string> = {
  validating: (to) => `Checking ${to}…`,
  downloading: (to) => `Downloading ${to}…`,
  backup: () => "Copying the database…",
  pulling: (to) => `Pulling the images of ${to}…`,
  starting: (to) => `Starting ${to}…`,
  "rolling-back": () => "The new version is not healthy: going back…",
  done: () => "Finishing…",
};

/** The last fetch of the status route: it answered with this, or it did not (the dashboard is restarting, or the network is down). */
export type FetchResult = { ok: true; payload: UpdatePayload } | { ok: false };

/**
 * What to show for the run that asked for `target` at `requestedAt` (ms, the dashboard's clock when it wrote the request: the
 * host's clock, as they are one machine). A status counts for this run only when it names `target` and started at or after the
 * request: an earlier run's result, a failure of the same version last week, is not this run's. `done` counts only when the
 * dashboard answering actually runs `target`: the host may report done a moment before the new container serves.
 */
export function updateView(input: { target: string; requestedAt: number; now: number; result: FetchResult }): UpdateView {
  const { target, requestedAt, now, result } = input;
  const unsettled = (kind: "waiting" | "running" | "restarting", text: string): UpdateView =>
    now - requestedAt > STALL_MS ? { kind: "stalled", text: "Nothing has changed for 15 minutes. Look at the update log on the host, then try again.", polling: false } : { kind, text, polling: true };

  if (!result.ok) return unsettled("restarting", "Restarting…");
  const { payload } = result;
  const s = payload.status;
  const mine = s !== null && s.to === target && s.startedAt >= requestedAt - START_TOLERANCE_MS;
  if (mine) {
    switch (s.state) {
      case "running":
        return unsettled("running", PHASE_TEXT[s.phase](target));
      case "done":
        return payload.version === target ? { kind: "done", text: `Updated to ${target}`, polling: false } : unsettled("restarting", "Restarting…");
      case "failed":
        return { kind: "failed", text: s.message === "" ? "The update did not complete." : `The update did not complete: ${s.message}`, polling: false };
      case "rolled_back":
        return { kind: "rolled_back", text: s.message === "" ? `Rolled back to ${s.from}.` : `Rolled back to ${s.from}: ${s.message}`, polling: false };
    }
  }
  // No status of this run: the running version is the truth (a lost status file does not hide an update that happened).
  if (payload.version === target) return { kind: "done", text: `Updated to ${target}`, polling: false };
  return unsettled("waiting", "Waiting for the host to start the update…");
}

/** The status route's answer as the client reads it, or null when it is not one (an error page from a proxy during the restart, say). */
export function parsePayload(value: unknown): UpdatePayload | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.updater !== "boolean" || typeof o.version !== "string" || typeof o.requested !== "boolean") return null;
  if (o.status === null) return { updater: o.updater, version: o.version, status: null, requested: o.requested };
  if (typeof o.status !== "object" || o.status === undefined) return null;
  const s = o.status as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const fits =
    typeof s.state === "string" && STATES.includes(s.state) &&
    typeof s.phase === "string" && PHASES.includes(s.phase) &&
    typeof s.from === "string" && typeof s.to === "string" && typeof s.message === "string" &&
    finite(s.startedAt) && (s.finishedAt === null || finite(s.finishedAt));
  if (!fits) return null;
  return { updater: o.updater, version: o.version, status: s as unknown as UpdateStatus, requested: o.requested };
}
