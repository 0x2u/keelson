import "server-only";
import { db } from "@/lib/db";
import { isBuildRunKey, type DeliveryOutcome } from "@/lib/github-webhook-core";
import type { BuildStart } from "@/lib/project-view-core";

/** How many delivery rows are kept, newest first. */
export const KEEP_DELIVERIES = 500;

export interface DeliveryRow {
  deliveryId: string;
  at: number;
  repo: string;
  branch: string;
  sha: string;
  serverId: string;
  app: string;
  outcome: DeliveryOutcome;
  detail: string;
  deploymentId: string | null;
  /** The workflow run (id and attempt) the delivery reports; null for rows from before it was kept. */
  runKey: string | null;
}

function toRow(row: Record<string, unknown>): DeliveryRow {
  return {
    deliveryId: String(row.delivery_id),
    at: Number(row.at),
    repo: String(row.repo),
    branch: String(row.branch),
    sha: String(row.sha),
    serverId: String(row.server_id),
    app: String(row.app),
    outcome: row.outcome as DeliveryOutcome,
    detail: String(row.detail),
    deploymentId: typeof row.deployment_id === "string" ? row.deployment_id : null,
    runKey: typeof row.run_key === "string" ? row.run_key : null,
  };
}

const COLUMNS = "delivery_id, at, repo, branch, sha, server_id, app, outcome, detail, deployment_id, run_key";

/** What is written for a delivery; the run key is optional (rows made without one cannot be matched by run). */
export type DeliveryWrite = Omit<DeliveryRow, "at" | "runKey"> & { runKey?: string | null };

/**
 * How long a `pending` claim blocks others. A claim older than this is a crash or a hang, not work in progress:
 * the longest a handler runs is the sum of its time budgets (about 10 s).
 */
export const PENDING_STALE_MS = 2 * 60 * 1000;

/** What an earlier attempt of this delivery did to this app, or null when it was never evaluated. */
export function findDelivery(deliveryId: string, serverId: string, app: string): DeliveryRow | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE delivery_id = ? AND server_id = ? AND app = ?`).get(deliveryId, serverId, app);
  return row ? toRow(row) : null;
}

/**
 * A delivery that may have started a deployment of this commit on the app without anyone knowing: the same delivery
 * id or the same commit, outcome `unknown`. Null when there is none.
 */
export function findUnknown(deliveryId: string, serverId: string, app: string, sha: string): DeliveryRow | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE server_id = ? AND app = ? AND outcome = 'unknown' AND (delivery_id = ? OR sha = ?) ORDER BY at DESC, id DESC LIMIT 1`)
    .get(serverId, app, deliveryId, sha);
  return row ? toRow(row) : null;
}

const UPSERT = `INSERT INTO webhook_deliveries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(delivery_id, server_id, app) DO UPDATE SET
    at = excluded.at, repo = excluded.repo, branch = excluded.branch, sha = excluded.sha,
    outcome = excluded.outcome, detail = excluded.detail, deployment_id = excluded.deployment_id, run_key = excluded.run_key`;

/** A recorded outcome replaces the row only if that cannot lose a deployment: `deployed` stays, `unknown` is not turned into a failure or skip. */
const GUARD = ` WHERE webhook_deliveries.outcome <> 'deployed' AND (webhook_deliveries.outcome <> 'unknown' OR excluded.outcome IN ('unknown', 'pending', 'deployed'))`;

function write(row: DeliveryWrite, now: number, guarded: boolean): number {
  const result = db()
    .prepare(UPSERT + (guarded ? GUARD : ""))
    .run(row.deliveryId, now, row.repo, row.branch, row.sha, row.serverId, row.app, row.outcome, row.detail, row.deploymentId, row.runKey ?? null);
  return Number(result.changes);
}

function prune(): void {
  db()
    .prepare("DELETE FROM webhook_deliveries WHERE id NOT IN (SELECT id FROM webhook_deliveries ORDER BY at DESC, id DESC LIMIT ?)")
    .run(KEEP_DELIVERIES);
}

/**
 * How long a build the GitHub App started keeps another source (a CI workflow run) from deploying the same commit
 * to the same app: the agent's longest build (an hour) plus its deployment. A build that fails frees the commit at
 * once (see failBuild).
 */
export const BUILD_HOLD_MS = 75 * 60 * 1000;

/** How long a build someone asked for answers a second ask for the same commit (see claimDelivery). */
export const MANUAL_REPEAT_MS = 2 * 60 * 1000;

/** `heldByBuild`: not a delivery of the same run, but a build of the same commit that is (or was just) deploying it. */
export type Claim = { claimed: true } | { claimed: false; existing: DeliveryRow; heldByBuild?: true };

/**
 * Claims an app for a delivery before any work is done: writes a `pending` row, or reports the row of whoever got
 * there first. Blocked by a `deployed` row for the same delivery id or workflow run (a redelivery, or a new delivery
 * id for the same run), and by a fresh `pending` row for the same delivery id, run or commit. Failed, skipped and
 * unknown rows, and stale pending ones, are taken over. A commit a GitHub App build has started deploying is not
 * claimed by anything but a build (a push and a CI workflow of the same commit never both deploy). Check and write are one transaction, so concurrent
 * deliveries (in this process or another) cannot both win.
 *
 * `repeatAfterMs` is for a person asking for a build (the Deploy button, the API): a `deployed` row of the same run
 * only answers for them for that long (a double click, an API retry). A webhook's redelivery of the same push is answered
 * for ever, but someone who asks again an hour later, or after changing where the build runs, wants a build.
 */
export function claimDelivery(row: Omit<DeliveryWrite, "outcome" | "detail" | "deploymentId">, now = Date.now(), repeatAfterMs?: number): Claim {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const runKey = row.runKey ?? null;
    const rows = conn
      .prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE server_id = ? AND app = ? AND (delivery_id = ? OR sha = ? OR (? IS NOT NULL AND run_key = ?)) ORDER BY at DESC, id DESC`)
      .all(row.serverId, row.app, row.deliveryId, row.sha, runKey, runKey)
      .map(toRow);
    const blocker = rows.find((r) => {
      if (r.outcome === "pending") return now - r.at < PENDING_STALE_MS;
      if (r.outcome !== "deployed") return false;
      if (r.deliveryId === row.deliveryId) return true;
      return runKey !== null && r.runKey === runKey && (repeatAfterMs === undefined || now - r.at < repeatAfterMs);
    });
    if (blocker) {
      conn.exec("COMMIT");
      return { claimed: false, existing: blocker };
    }
    if (!isBuildRunKey(runKey)) {
      const building = rows.find((r) => r.outcome === "deployed" && r.sha === row.sha && isBuildRunKey(r.runKey) && now - r.at < BUILD_HOLD_MS);
      if (building) {
        conn.exec("COMMIT");
        return { claimed: false, existing: building, heldByBuild: true };
      }
    }
    write({ ...row, outcome: "pending", detail: "being handled", deploymentId: null }, now, false);
    conn.exec("COMMIT");
    prune();
    return { claimed: true };
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Records the outcome of a delivery for an app and returns the row as stored. GitHub's "Redeliver" reuses the
 * delivery id: the new outcome replaces the old row, except that a `deployed` row is never replaced and an
 * `unknown` one only by an outcome that settles it (the stored row is returned then). Keeps only the newest
 * KEEP_DELIVERIES rows.
 */
export function recordDelivery(row: DeliveryWrite, now = Date.now()): DeliveryRow {
  const changes = write(row, now, true);
  if (changes > 0) prune();
  return findDelivery(row.deliveryId, row.serverId, row.app)!;
}

/** The latest deliveries that concerned an app, newest first. */
export function recentDeliveries(serverId: string, app: string, limit = 10): DeliveryRow[] {
  return db()
    .prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE server_id = ? AND app = ? ORDER BY at DESC, id DESC LIMIT ?`)
    .all(serverId, app, limit)
    .map(toRow);
}

/** Adds a note to the detail of a delivery that was deployed: what happened after the answer, such as a status that could not be posted. */
export function annotateDelivery(deliveryId: string, serverId: string, app: string, note: string): void {
  db()
    .prepare("UPDATE webhook_deliveries SET detail = detail || ' (' || ? || ')' WHERE delivery_id = ? AND server_id = ? AND app = ? AND outcome = 'deployed'")
    .run(note, deliveryId, serverId, app);
}

/** The latest deliveries that concerned the previews of an app (`<app>-pr-<n>`), newest first. */
export function recentPreviewDeliveries(serverId: string, app: string, limit = 10): DeliveryRow[] {
  const prefix = `${app}-pr-`;
  return db()
    .prepare(`SELECT ${COLUMNS} FROM webhook_deliveries WHERE server_id = ? AND length(app) > ? AND substr(app, 1, ?) = ? AND substr(app, ? + 1) NOT GLOB '*[^0-9]*' ORDER BY at DESC, id DESC LIMIT ?`)
    .all(serverId, prefix.length, prefix.length, prefix, prefix.length, limit)
    .map(toRow);
}

/**
 * A build that ended without succeeding: its row, recorded as deployed when the agent accepted it, becomes a failure
 * with the reason, which frees the commit for another source or a redelivery. Nothing else is changed.
 */
export function failBuild(deliveryId: string, serverId: string, app: string, error: string): void {
  db()
    .prepare("UPDATE webhook_deliveries SET outcome = 'failed', detail = ? WHERE delivery_id = ? AND server_id = ? AND app = ? AND outcome = 'deployed'")
    .run(`the build or deployment failed: ${error.replace(/\s+/g, " ").slice(0, 300)}`, deliveryId, serverId, app);
}

/** The latest builds the GitHub App started for an app and its previews (`<app>-pr-<n>`), newest first. */
export function recentBuildDeliveries(serverId: string, app: string, limit = 10): DeliveryRow[] {
  const prefix = `${app}-pr-`;
  return db()
    .prepare(
      `SELECT ${COLUMNS} FROM webhook_deliveries WHERE server_id = ? AND (app = ? OR (length(app) > ? AND substr(app, 1, ?) = ? AND substr(app, ? + 1) NOT GLOB '*[^0-9]*'))
       AND (run_key GLOB '*#push#*' OR run_key GLOB '*#pr[0-9]*#*') ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(serverId, app, prefix.length, prefix.length, prefix, prefix.length, limit)
    .map(toRow);
}

/** The prefix of the delivery id the dashboard gives a build it started itself (see `startBuild`); a push brings GitHub's own id. */
const DASHBOARD_BUILD_ID = "dashboard-build:";

/**
 * Who started the builds of an app that the agent accepted, by commit (full hash): a push to the linked branch or the
 * dashboard's Deploy. The newest delivery of a commit decides. Previews, workflow runs and builds that failed are not here.
 */
export function buildStarts(serverId: string, app: string, limit = KEEP_DELIVERIES): Record<string, BuildStart> {
  const rows = db()
    .prepare(`SELECT sha, delivery_id FROM webhook_deliveries WHERE server_id = ? AND app = ? AND outcome = 'deployed' AND run_key GLOB '*#push#*' ORDER BY at DESC, id DESC LIMIT ?`)
    .all(serverId, app, limit);
  const starts: Record<string, BuildStart> = {};
  for (const row of rows) {
    const sha = String(row.sha);
    starts[sha] ??= String(row.delivery_id).startsWith(DASHBOARD_BUILD_ID) ? "dashboard" : "push";
  }
  return starts;
}
