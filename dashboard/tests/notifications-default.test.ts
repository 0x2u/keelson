import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationsTemplate } from "@/lib/notifications-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-notifications-default-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// Imported after the data dir is set: the database opens lazily on first use.
const { db, openDatabase, SCHEMA_VERSION } = await import("@/lib/db");
const { getNotificationsDefault, setNotificationsDefault } = await import("@/lib/notifications-default");

const TEMPLATE: NotificationsTemplate = {
  events: ["deployment.failed", "app.down"],
  diskPercent: 90,
  memoryPercent: 15,
  cooldown: "10m",
  telegram: { botTokenFile: "/etc/keelson/bot", chatId: "-100", apiUrl: "" },
  webhooks: [{ secretFile: "/etc/keelson/hook" }, { secretFile: "" }],
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db().exec("DELETE FROM notifications_default");
});

describe("the notifications_default table", () => {
  it("exists in a fresh database, empty, with no default", () => {
    const fresh = openDatabase(path.join(dir, "fresh.db"));
    try {
      expect(fresh.prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 0 });
      expect(fresh.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    } finally {
      fresh.close();
    }
    expect(getNotificationsDefault()).toBeNull();
  });

  it("holds one row: the id can only be 1", () => {
    const insert = db().prepare("INSERT INTO notifications_default (id, body, updated_at) VALUES (?, '{}', 1)");
    insert.run(1);
    expect(() => insert.run(2)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(1)).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 1 });
  });

  it("is created when upgrading the database that came before the migration", () => {
    const file = path.join(dir, "before-notifications-default.db");
    const old = openDatabase(file);
    old.exec("DROP TABLE notifications_default");
    for (const table of ["admin_password", "setup_token", "setup_recovery", "pending_logins"]) old.exec(`DROP TABLE ${table}`);
    old.exec("ALTER TABLE relay_codes DROP COLUMN server_id");
    old.exec("ALTER TABLE relay_codes DROP COLUMN kind");
    old.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 4}`);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 0 });
      upgraded.prepare("INSERT INTO notifications_default (id, body, updated_at) VALUES (1, '{}', 1)").run();
      expect(() => upgraded.prepare("INSERT INTO notifications_default (id, body, updated_at) VALUES (2, '{}', 1)").run()).toThrow();
    } finally {
      upgraded.close();
    }
  });
});

describe("get and set the default", () => {
  it("round-trips a template with the time it was saved", () => {
    setNotificationsDefault(TEMPLATE, 1_700_000_000_000);
    expect(getNotificationsDefault()).toEqual({ template: TEMPLATE, updatedAt: 1_700_000_000_000 });
  });

  it("replaces the one row on a second save", () => {
    setNotificationsDefault(TEMPLATE, 1);
    const next: NotificationsTemplate = { ...TEMPLATE, diskPercent: 70, telegram: null, webhooks: [] };
    setNotificationsDefault(next, 2);
    expect(getNotificationsDefault()).toEqual({ template: next, updatedAt: 2 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 1 });
  });

  it("stores only the template: paths of secret files, never a URL", () => {
    setNotificationsDefault(TEMPLATE, 1);
    const row = db().prepare("SELECT body FROM notifications_default WHERE id = 1").get() as { body: string };
    expect(JSON.parse(row.body)).toEqual(TEMPLATE);
    expect(row.body).not.toMatch(/https?:/);
  });

  it("does not take a stored row that is no longer a valid template for the default", () => {
    db().prepare("INSERT INTO notifications_default (id, body, updated_at) VALUES (1, ?, 1)").run(JSON.stringify({ ...TEMPLATE, diskPercent: 5 }));
    expect(getNotificationsDefault()).toBeNull();
  });
});
