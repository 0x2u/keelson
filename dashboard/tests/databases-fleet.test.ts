import { describe, expect, it } from "vitest";
import type { DatabaseBackupRun, DatabaseStatus } from "@/lib/agent-types";
import type { ServerSnapshot } from "@/lib/attention-core";
import { databaseRows } from "@/lib/databases-fleet-core";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const run = (over: Partial<DatabaseBackupRun> = {}): DatabaseBackupRun => ({ id: "r", status: "succeeded", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR), ...over }) as DatabaseBackupRun;

const db = (name: string, backup: Partial<NonNullable<DatabaseStatus["backup"]>> | null): DatabaseStatus => ({
  name,
  engine: "postgres",
  host: "db",
  port: 5432,
  database: name,
  user: "u",
  version: 16,
  network: "",
  has_password: true,
  backup: backup === null ? null : { schedule: "0 3 * * *", timezone: "UTC", keep: 7, keep_days: 0, paused: false, destination: "local:/b", recipients: 1, job: `backup-${name}`, next_run: ago(-HOUR), last_run: run(), ...backup },
});

const server = (id: string, name: string, databases: DatabaseStatus[] | null | undefined, over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({ server: { id, name }, reachable: true, lastSeen: NOW, databases, ...over });
const down = (id: string, name: string): ServerSnapshot => ({ server: { id, name }, reachable: false, reason: "connect ECONNREFUSED", lastSeen: null });

const fleet = (): ServerSnapshot[] => [
  server("s1", "alpha", [
    db("fine", {}),
    db("failed", { last_run: run({ status: "failed", detail: "pg_dump: connection refused" }) }),
    db("overdue", { last_run: run({ started_at: ago(5 * 24 * HOUR), finished_at: ago(5 * 24 * HOUR) }) }),
    db("bare", null),
    db("paused", { paused: true }),
    db("fresh", { last_run: null }),
    db("running", { last_run: run({ status: "running", finished_at: undefined }) }),
  ]),
  server("s2", "beta", [db("also-failed", { last_run: run({ status: "failed" }) }), db("also-fine", {})]),
];

describe("the fleet's databases", () => {
  it("orders the problems first: failed, then overdue, then not backed up, then paused, then the quiet ones", () => {
    const { rows } = databaseRows(fleet(), NOW);
    expect(rows.map((r) => `${r.server.name}/${r.database.name}:${r.state}`)).toEqual([
      "alpha/failed:failed",
      "beta/also-failed:failed",
      "alpha/overdue:overdue",
      "alpha/bare:not-configured",
      "alpha/paused:paused",
      "alpha/fresh:first-pending",
      "alpha/running:running",
      "alpha/fine:ok",
      "beta/also-fine:ok",
    ]);
  });

  it("explains a failed or overdue backup with the cause the agent gave, and nothing for a fine one", () => {
    const { rows } = databaseRows(fleet(), NOW);
    const by = (n: string) => rows.find((r) => r.database.name === n);
    expect(by("failed")?.detail).toContain("pg_dump: connection refused");
    expect(by("overdue")?.detail).toContain("more than 2 schedule periods");
    expect(by("fine")?.detail).toBeUndefined();
  });

  it("separates the servers that did not answer, with why, instead of listing nothing for them", () => {
    const { rows, unanswered } = databaseRows([...fleet(), down("s3", "gamma")], NOW);
    expect(unanswered).toEqual([{ id: "s3", name: "gamma", reason: "connect ECONNREFUSED" }]);
    expect(rows.some((r) => r.server.id === "s3")).toBe(false);
  });

  it("treats a failed database list on a server that answers as unknown, and an agent without an apps file as having none", () => {
    const { rows, unanswered } = databaseRows([server("s1", "alpha", undefined, { errors: { databases: "boom" } }), server("s2", "beta", null)], NOW);
    expect(rows).toEqual([]);
    expect(unanswered).toEqual([{ id: "s1", name: "alpha", reason: "boom" }]);
  });
});
