import { describe, expect, it } from "vitest";
import type { DatabaseConfig } from "@/lib/agent-types";
import { databaseFromDraft, draftFromDatabase, validateDatabase, type DatabaseDraft } from "@/lib/database-config";

const RECIPIENT = `age1${"q".repeat(58)}`;

function valid(over: Partial<DatabaseDraft> = {}): DatabaseDraft {
  return {
    ...draftFromDatabase(undefined),
    name: "shop",
    host: "127.0.0.1",
    database: "shop",
    user: "shop",
    recipients: [RECIPIENT],
    localDir: "/var/backups/keelson",
    ...over,
  };
}

describe("database configuration to send", () => {
  it("sends only what was filled in for a database without backup", () => {
    expect(databaseFromDraft(valid({ backup: false, port: "", passwordFile: " /etc/keelson/db-shop " }))).toEqual({
      name: "shop",
      host: "127.0.0.1",
      database: "shop",
      user: "shop",
      password_file: "/etc/keelson/db-shop",
    });
  });

  it("sends the chosen destination only", () => {
    const local = databaseFromDraft(valid({ s3Bucket: "left over" })).backups;
    expect(local?.destinations).toEqual([{ local: { dir: "/var/backups/keelson" } }]);

    const s3 = databaseFromDraft(
      valid({ destination: "s3", s3Endpoint: "https://s3.example.com", s3Region: "eu-west-1", s3Bucket: "b", s3AccessKeyId: "AK", s3SecretKeyFile: "/etc/s3" }),
    ).backups;
    expect(s3?.destinations).toEqual([{ s3: { endpoint: "https://s3.example.com", region: "eu-west-1", bucket: "b", access_key_id: "AK", secret_key_file: "/etc/s3" } }]);
  });

  it("parses numbers, drops empty recipients and keeps a paused schedule", () => {
    const db = databaseFromDraft(valid({ port: "6432", version: "16", keep: "7", keepDays: "30", alertAfter: "2", paused: true, recipients: [` ${RECIPIENT} `, ""] }));
    expect(db).toMatchObject({ port: 6432, version: 16, backups: { keep: 7, keep_days: 30, alert_after: 2, paused: true, recipients: [RECIPIENT] } });
  });

  it("round-trips a configuration read from the agent", () => {
    const stored: DatabaseConfig = {
      name: "shop",
      host: "db.internal",
      port: 5432,
      database: "shop",
      user: "shop",
      ssl_mode: "require",
      backups: {
        schedule: "0 3 * * *",
        timezone: "Europe/Paris",
        recipients: [RECIPIENT],
        keep: 14,
        destinations: [{ s3: { endpoint: "https://s3.example.com", region: "r", bucket: "b", prefix: "keelson", access_key_id: "AK", secret_key_file: "/etc/s3" } }],
      },
    };
    expect(databaseFromDraft(draftFromDatabase(stored))).toEqual(stored);
  });
});

describe("database form validation", () => {
  it("accepts a complete form", () => {
    expect(validateDatabase(valid(), true, [])).toEqual({});
  });

  it("refuses a taken or malformed name only when creating", () => {
    expect(validateDatabase(valid({ name: "shop" }), true, ["shop"]).name).toMatch(/already exists/);
    expect(validateDatabase(valid({ name: "Shop DB" }), true, []).name).toBeDefined();
    expect(validateDatabase(valid({ name: "shop" }), false, ["shop"]).name).toBeUndefined();
  });

  it("checks the port and client version ranges", () => {
    expect(validateDatabase(valid({ port: "0" }), true, []).port).toBeDefined();
    expect(validateDatabase(valid({ port: "65536" }), true, []).port).toBeDefined();
    expect(validateDatabase(valid({ version: "9" }), true, []).version).toBeDefined();
    expect(validateDatabase(valid({ version: "100" }), true, []).version).toBeDefined();
    expect(validateDatabase(valid({ port: "65535", version: "99" }), true, [])).toEqual({});
  });

  it("requires an age public key, not a secret key", () => {
    expect(validateDatabase(valid({ recipients: [""] }), true, []).recipients).toMatch(/at least one/);
    expect(validateDatabase(valid({ recipients: [`AGE-SECRET-KEY-1${"Q".repeat(58)}`] }), true, []).recipients).toMatch(/public key/);
  });

  it("skips every backup check when backups are off", () => {
    expect(validateDatabase(valid({ backup: false, recipients: [""], schedule: "nonsense", localDir: "relative" }), true, [])).toEqual({});
  });

  it("wants absolute paths", () => {
    expect(validateDatabase(valid({ localDir: "backups" }), true, []).local_dir).toBeDefined();
    expect(validateDatabase(valid({ passwordFile: "db-pass" }), true, []).password_file).toBeDefined();
  });

  it("accepts plain http only for a loopback S3 endpoint", () => {
    const s3 = { destination: "s3" as const, s3Region: "r", s3Bucket: "b", s3AccessKeyId: "AK", s3SecretKeyFile: "/etc/s3" };
    expect(validateDatabase(valid({ ...s3, s3Endpoint: "http://s3.example.com" }), true, []).s3_endpoint).toBeDefined();
    expect(validateDatabase(valid({ ...s3, s3Endpoint: "http://127.0.0.1:9000" }), true, [])).toEqual({});
    expect(validateDatabase(valid({ ...s3, s3Endpoint: "https://s3.example.com", s3Prefix: "/lead" }), true, []).s3_prefix).toBeDefined();
  });
});

describe("a database that backs up to several places, or keeps pre-deploy backups apart", () => {
  const destinations = [{ local: { dir: "/var/backups/keelson" } }, { s3: { endpoint: "https://s3.example.com", region: "eu", bucket: "b", access_key_id: "AK", secret_key_file: "/etc/keelson/s3" } }];
  const stored = {
    name: "shop",
    host: "127.0.0.1",
    database: "shop",
    user: "shop",
    backups: { schedule: "0 3 * * *", recipients: [RECIPIENT], keep: 14, keep_pre_deploy: 3, destinations },
  } as Parameters<typeof draftFromDatabase>[0];

  it("opens in the form without failing and sends the destinations back as they are, never as a single one", () => {
    const draft = draftFromDatabase(stored);
    expect(draft.destinations).toEqual(destinations);
    expect(draft.keepPreDeploy).toBe("3");
    const sent = databaseFromDraft(draft);
    expect(sent).toEqual(stored);
    expect(sent).not.toHaveProperty("backup");
    expect(sent.backups).not.toHaveProperty("destination");
    expect(validateDatabase(draft, false, [])).toEqual({});
  });

  it("keeps keep_pre_deploy when other fields are edited, and rejects a bad count", () => {
    const draft = { ...draftFromDatabase(stored), keep: "7" };
    expect(databaseFromDraft(draft).backups).toMatchObject({ keep: 7, keep_pre_deploy: 3 });
    expect(validateDatabase({ ...draft, keepPreDeploy: "x" }, false, [])).toHaveProperty("keep_pre_deploy");
  });

  it("refuses a zero count: the agent reads keep: 0 as the default and warns that it is deprecated", () => {
    const draft = draftFromDatabase(stored);
    expect(validateDatabase({ ...draft, keep: "0" }, false, [])).toHaveProperty("keep");
    expect(validateDatabase({ ...draft, keepPreDeploy: "0" }, false, [])).toHaveProperty("keep_pre_deploy");
    expect(validateDatabase({ ...draft, keepDays: "0" }, false, [])).toEqual({});
  });

  it("writes the schema v1 spelling only (backups, a destinations list): the agent accepts it without a deprecation warning", () => {
    const sent = databaseFromDraft({ ...draftFromDatabase(undefined), name: "shop", host: "h", database: "d", user: "u", localDir: "/b", recipients: [RECIPIENT] });
    expect(sent).toHaveProperty("backups.destinations", [{ local: { dir: "/b" } }]);
    expect(JSON.stringify(sent)).not.toMatch(/"backup"|"destination"/);
  });
});
