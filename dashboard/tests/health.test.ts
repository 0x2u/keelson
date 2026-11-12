import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-health-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

const { db } = await import("@/lib/db");
const { checkHealth, resetHealthCache } = await import("@/lib/health");
const { GET } = await import("@/app/api/health/route");

/** A value in the dashboard's storage format, encrypted with some other key: what a wrong KEELSON_DASHBOARD_KEY leaves behind. */
function foreign(): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", randomBytes(32), iv);
  const body = Buffer.concat([cipher.update("secret", "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

beforeEach(() => {
  for (const table of ["key_check", "servers"]) db().exec(`DELETE FROM ${table}`);
  db().exec("UPDATE auth_factor SET totp_secret_enc = NULL WHERE id = 1");
  resetHealthCache();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the dashboard's health", () => {
  it("is healthy on a new database and writes a value the key can be proved against later", () => {
    expect(checkHealth()).toEqual({ ok: true });
    expect(db().prepare("SELECT COUNT(*) AS n FROM key_check").get()).toEqual({ n: 1 });
    resetHealthCache();
    expect(checkHealth()).toEqual({ ok: true });
  });

  it("is unhealthy when the key is not the one the data was written with, and says only that", () => {
    checkHealth(); // writes the check value
    db().prepare("UPDATE key_check SET value_enc = ? WHERE id = 1").run(foreign());
    resetHealthCache();
    expect(checkHealth()).toEqual({ ok: false, reason: "key" });
  });

  it("proves the key against a stored secret when there is one, and never writes a check value over a wrong key", () => {
    db()
      .prepare("INSERT INTO servers (id, name, url, token_enc, created_at, updated_at) VALUES ('s', 'a', 'https://a.example.com', ?, 1, 1)")
      .run(foreign());
    expect(checkHealth()).toEqual({ ok: false, reason: "key" });
    expect(db().prepare("SELECT COUNT(*) AS n FROM key_check").get()).toEqual({ n: 0 });
  });

  it("looks again after five seconds, not before", () => {
    const t0 = 1_000_000;
    expect(checkHealth(t0)).toEqual({ ok: true });
    db().prepare("UPDATE key_check SET value_enc = ? WHERE id = 1").run(foreign());
    expect(checkHealth(t0 + 4_000)).toEqual({ ok: true });
    expect(checkHealth(t0 + 6_000)).toEqual({ ok: false, reason: "key" });
  });

  it("answers 503 with a coarse reason and nothing else when unhealthy, 200 when healthy", async () => {
    expect((await GET()).status).toBe(200);
    db().prepare("UPDATE key_check SET value_enc = ? WHERE id = 1").run(foreign());
    resetHealthCache();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unhealthy", reason: "key" });
  });
});
