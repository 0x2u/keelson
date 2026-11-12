import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, openDatabase } from "@/lib/db";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-db-upgrade-copy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/**
 * A database as the version before this one left it, with a row only that data has: the columns the last migration adds are
 * taken away and the version put back, so the next open runs that migration.
 */
function oldDatabase(file: string): void {
  const db = openDatabase(file);
  db.exec("ALTER TABLE relay_codes DROP COLUMN server_id");
  db.exec("ALTER TABLE relay_codes DROP COLUMN kind");
  db.exec("INSERT INTO audit_log (at, event, detail, ip) VALUES (7, 'login', 'before the update', '1.1.1.1')");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  db.close();
}

const copiesOf = (file: string) => readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.before-upgrade-from-v`)).sort();

describe("the copy taken before the schema changes", () => {
  it("is a consistent, private copy of the data as it was, named after the version it came from", () => {
    const file = path.join(dir, "a", "dashboard.db");
    mkdirSync(path.dirname(file));
    oldDatabase(file);

    const upgraded = openDatabase(file);
    upgraded.close();
    expect(copiesOf(file)).toEqual([`dashboard.db.before-upgrade-from-v${SCHEMA_VERSION - 1}`]);
    const copy = `${file}.before-upgrade-from-v${SCHEMA_VERSION - 1}`;
    expect(statSync(copy).mode & 0o777).toBe(0o600);

    const kept = new DatabaseSync(copy);
    try {
      expect(kept.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION - 1 });
      expect(kept.prepare("SELECT detail FROM audit_log").all()).toEqual([{ detail: "before the update" }]);
    } finally {
      kept.close();
    }
    // The copy is what the old version needs: the upgraded database is the newer one.
    const after = new DatabaseSync(file);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    } finally {
      after.close();
    }
  });

  it("is not made for a new database, nor for one that is up to date", () => {
    const file = path.join(dir, "b.db");
    openDatabase(file).close();
    expect(copiesOf(file)).toEqual([]);
    openDatabase(file).close();
    expect(copiesOf(file)).toEqual([]);
  });

  it("keeps the newest three and removes the older ones", () => {
    const file = path.join(dir, "c.db");
    // Copies of three earlier upgrades, each a day older than the next.
    for (const v of [1, 2, 3]) {
      writeFileSync(`${file}.before-upgrade-from-v${v}`, `copy ${v}`);
      const at = new Date(Date.now() - (4 - v) * 86_400_000);
      utimesSync(`${file}.before-upgrade-from-v${v}`, at, at);
    }
    oldDatabase(file);
    openDatabase(file).close();
    expect(copiesOf(file)).toEqual(["c.db.before-upgrade-from-v2", "c.db.before-upgrade-from-v3", `c.db.before-upgrade-from-v${SCHEMA_VERSION - 1}`].sort());
  });

  it("is replaced when the same upgrade is made again, for instance after restoring a backup", () => {
    const file = path.join(dir, "d.db");
    oldDatabase(file);
    openDatabase(file).close();
    oldDatabase(file);
    openDatabase(file).close();
    expect(copiesOf(file)).toHaveLength(1);
  });

  it("does not stop the upgrade when it cannot be written: a warning is logged and the schema is upgraded", () => {
    const file = path.join(dir, "e.db");
    oldDatabase(file);
    // A directory where the copy goes: it cannot be made.
    mkdirSync(`${file}.before-upgrade-from-v${SCHEMA_VERSION - 1}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(upgraded.prepare("SELECT detail FROM audit_log").all()).toEqual([{ detail: "before the update" }]);
    } finally {
      upgraded.close();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not copy the database before upgrading it"));
  });
});

describe("a database from a newer version", () => {
  it("is refused, with the way back, and is left as it was", () => {
    const file = path.join(dir, "f.db");
    const db = openDatabase(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => openDatabase(file)).toThrow(/newer than this dashboard supports: restore the copy taken before the update \(Settings > Backup\) or run the newer version/);
    expect(existsSync(file)).toBe(true);
    expect(copiesOf(file)).toEqual([]);
  });
});
