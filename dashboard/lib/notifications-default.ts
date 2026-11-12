import "server-only";
import { db } from "@/lib/db";
import { parseTemplate, type NotificationsTemplate } from "@/lib/notifications-core";

// The default notification settings: one row of non-secret JSON (see the migration). It is what the operator applies to servers
// on demand, never what a server is told to be: the agents' files stay the truth.

export interface StoredDefault {
  template: NotificationsTemplate;
  /** When it was last saved (ms). */
  updatedAt: number;
}

export function getNotificationsDefault(): StoredDefault | null {
  const row = db().prepare("SELECT body, updated_at FROM notifications_default WHERE id = 1").get() as { body: string; updated_at: number } | undefined;
  if (row === undefined) return null;
  // Written only through `setNotificationsDefault`, which validated it: a row that no longer parses is not a default.
  const parsed = parseTemplate(JSON.parse(row.body));
  return parsed.ok ? { template: parsed.template, updatedAt: row.updated_at } : null;
}

export function setNotificationsDefault(template: NotificationsTemplate, at: number): void {
  db()
    .prepare("INSERT INTO notifications_default (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
    .run(JSON.stringify(template), at);
}

