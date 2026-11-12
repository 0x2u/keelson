import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-dash-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

// Imported after the data dir is set: the database opens lazily on first use.
const servers = await import("@/lib/servers");
const { db } = await import("@/lib/db");

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);

beforeAll(() => {
  db().exec("DELETE FROM servers");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("server registry", () => {
  it("stores secrets encrypted and returns them only through credentials", () => {
    const id = servers.createServer({ name: "vps-1", url: "https://a.example.com/", token: TOKEN, deploySecret: SECRET });

    const raw = db().prepare("SELECT * FROM servers WHERE id = ?").get(id);
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect(JSON.stringify(raw)).not.toContain(SECRET);

    const summary = servers.getServer(id)!;
    expect(summary).toMatchObject({ name: "vps-1", url: "https://a.example.com", canDeploy: true });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);

    const creds = servers.getCredentials(id)!;
    expect(creds.token).toBe(TOKEN);
    expect(creds.deploySecret).toBe(SECRET);
  });

  it("treats a missing deploy secret as read-only", () => {
    const id = servers.createServer({ name: "ro", url: "http://10.0.0.1:7070", token: TOKEN });
    expect(servers.getServer(id)!.canDeploy).toBe(false);
    expect(servers.getCredentials(id)!.deploySecret).toBeNull();
  });

  it("rejects duplicate names and invalid URLs", () => {
    servers.createServer({ name: "dup", url: "https://d.example.com", token: TOKEN });
    expect(() => servers.createServer({ name: "dup", url: "https://e.example.com", token: TOKEN })).toThrow(servers.DuplicateServerError);
    expect(() => servers.createServer({ name: "bad", url: "ftp://x", token: TOKEN })).toThrow();
  });

  it("keeps stored secrets when an update leaves them empty, and replaces them otherwise", () => {
    const id = servers.createServer({ name: "upd", url: "https://u.example.com", token: TOKEN, deploySecret: SECRET });
    const before = servers.getCredentials(id)!;

    servers.updateServer(id, { name: "upd2", url: "https://u2.example.com", token: "", deploySecret: "", caCert: "", clientCert: "" });
    const kept = servers.getCredentials(id)!;
    expect(kept).toMatchObject({ name: "upd2", url: "https://u2.example.com", token: TOKEN, deploySecret: SECRET });
    expect(kept.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    servers.updateServer(id, { name: "upd2", url: "https://u2.example.com", token: "n".repeat(40), caCert: "", clientCert: "" });
    expect(servers.getCredentials(id)!.token).toBe("n".repeat(40));
    expect(servers.getCredentials(id)!.deploySecret).toBe(SECRET);

    servers.updateServer(id, { name: "upd2", url: "https://u2.example.com", removeDeploySecret: true, caCert: "", clientCert: "" });
    expect(servers.getServer(id)!.canDeploy).toBe(false);
  });

  it("drops the client key when the client certificate is removed", () => {
    const cert = "-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----";
    const key = "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----";
    const id = servers.createServer({ name: "mtls", url: "https://m.example.com", token: TOKEN, clientCert: cert, clientKey: key });
    expect(servers.getCredentials(id)).toMatchObject({ clientCert: cert, clientKey: key });

    servers.updateServer(id, { name: "mtls", url: "https://m.example.com", caCert: "", clientCert: cert });
    expect(servers.getCredentials(id)!.clientKey).toBe(key); // blank key keeps the stored one

    servers.updateServer(id, { name: "mtls", url: "https://m.example.com", caCert: "", clientCert: "" });
    expect(servers.getCredentials(id)).toMatchObject({ clientCert: null, clientKey: null });
  });

  it("reports unknown servers and deletes", () => {
    expect(servers.getServer("nope")).toBeNull();
    expect(servers.updateServer("nope", { name: "x", url: "https://x.com", caCert: "", clientCert: "" })).toBe(false);
    const id = servers.createServer({ name: "gone", url: "https://g.example.com", token: TOKEN });
    expect(servers.deleteServer(id)).toBe(true);
    expect(servers.deleteServer(id)).toBe(false);
    expect(servers.listServers().map((s) => s.name)).not.toContain("gone");
  });
});

describe("a server whose credentials cannot be decrypted", () => {
  it("is marked unreadable, with empty secrets, and is still listed and removable, while the others are read as usual", () => {
    const good = servers.createServer({ name: "good", url: "https://good.example.com/", token: TOKEN, deploySecret: SECRET });
    const bad = servers.createServer({ name: "bad", url: "https://bad.example.com/", token: TOKEN });
    // What a master key that is not the one the data was written with leaves: a value in the storage format that does not decrypt.
    db().prepare("UPDATE servers SET token_enc = ? WHERE id = ?").run("v1:" + Buffer.alloc(40, 7).toString("base64"), bad);

    expect(servers.getCredentials(bad)).toMatchObject({ id: bad, name: "bad", token: "", deploySecret: null, clientKey: null, unreadable: true });
    expect(servers.getCredentials(good)).toMatchObject({ token: TOKEN, deploySecret: SECRET });
    expect(servers.getCredentials(good)?.unreadable).toBeUndefined();
    expect(servers.listServers().map((s) => s.name)).toEqual(expect.arrayContaining(["good", "bad"]));
    servers.deleteServer(bad);
    expect(servers.getCredentials(bad)).toBeNull();
  });
});

describe("last seen", () => {
  it("is empty until the agent answers, and never moves backwards", () => {
    const id = servers.createServer({ name: "seen-1", url: "https://seen.example.com", token: TOKEN });
    expect(servers.lastSeen(id)).toBeNull();
    servers.markSeen(id, 2000);
    servers.markSeen(id, 1000); // a slower, older answer arriving late
    expect(servers.lastSeen(id)).toBe(2000);
    servers.markSeen(id, 3000);
    expect(servers.lastSeen(id)).toBe(3000);
  });
});

describe("the public address", () => {
  const update = { name: "pub", url: "https://p.example.com", caCert: "", clientCert: "" };

  it("is empty until set, kept when an update leaves it out, replaced when given, and cleared when emptied", () => {
    const id = servers.createServer({ name: "pub", url: "https://p.example.com", token: TOKEN });
    expect(servers.getServer(id)!.publicIp).toBeNull();
    servers.updateServer(id, { ...update, publicIp: "203.0.113.7" });
    expect(servers.getServer(id)!.publicIp).toBe("203.0.113.7");
    servers.updateServer(id, update);
    expect(servers.getServer(id)!.publicIp).toBe("203.0.113.7");
    servers.updateServer(id, { ...update, publicIp: "2001:db8::7" });
    expect(servers.getCredentials(id)!.publicIp).toBe("2001:db8::7");
    servers.updateServer(id, { ...update, publicIp: "  " });
    expect(servers.getServer(id)!.publicIp).toBeNull();
  });

  it("can be given when the server is added", () => {
    const id = servers.createServer({ name: "pub-new", url: "https://p2.example.com", token: TOKEN, publicIp: "198.51.100.4" });
    expect(servers.getServer(id)!.publicIp).toBe("198.51.100.4");
  });
});

describe("the apps domain", () => {
  const update = { name: "dom", url: "https://d.example.com", caCert: "", clientCert: "" };

  it("is empty until set, replaced when set again, cleared with null, and left alone by an update of the server", () => {
    const id = servers.createServer({ name: "dom", url: "https://d.example.com", token: TOKEN });
    expect(servers.getServer(id)!.appsDomain).toBeNull();
    expect(servers.setAppsDomain(id, "apps.example.com")).toBe(true);
    expect(servers.getServer(id)!.appsDomain).toBe("apps.example.com");
    expect(servers.getCredentials(id)!.appsDomain).toBe("apps.example.com");
    servers.updateServer(id, { ...update, publicIp: "203.0.113.7" });
    expect(servers.getServer(id)!.appsDomain).toBe("apps.example.com");
    expect(servers.setAppsDomain(id, "other.example.org")).toBe(true);
    expect(servers.getServer(id)!.appsDomain).toBe("other.example.org");
    expect(servers.setAppsDomain(id, null)).toBe(true);
    expect(servers.getServer(id)!.appsDomain).toBeNull();
  });

  it("is not set for a server that is not there", () => {
    expect(servers.setAppsDomain("nope", "apps.example.com")).toBe(false);
  });
});

describe("the schema upgrade for the public address and the apps domain", () => {
  it("adds the new columns to the version before them, keeping the servers (which stay direct)", async () => {
    const { openDatabase, SCHEMA_VERSION } = await import("@/lib/db");
    const file = path.join(dir, "before-public-ip.db");
    const old = openDatabase(file);
    old.exec("ALTER TABLE servers DROP COLUMN serves");
    old.exec("DROP TABLE relay_codes");
    old.exec("DROP INDEX servers_relay_credential");
    old.exec("ALTER TABLE servers DROP COLUMN relay_credential_hash");
    old.exec("ALTER TABLE servers DROP COLUMN transport");
    old.exec("ALTER TABLE app_repos DROP COLUMN build_server");
    old.exec("ALTER TABLE servers DROP COLUMN apps_domain");
    old.exec("ALTER TABLE servers DROP COLUMN public_ip");
    old.exec(`INSERT INTO servers (id, name, url, token_enc, created_at, updated_at) VALUES ('s1', 'old', 'https://o.example.com', 'x', 1, 1)`);
    old.exec("ALTER TABLE sessions DROP COLUMN elevated_until");
    old.exec("DROP TABLE key_check");
    old.exec("DROP TABLE dashboard_backup");
    old.exec("DROP TABLE notifications_default");
    old.exec("DROP TABLE pending_logins");
    for (const table of ["admin_password", "setup_token", "setup_recovery"]) old.exec(`DROP TABLE ${table}`);
    old.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 12}`);
    old.close();

    const upgraded = openDatabase(file);
    try {
      expect(upgraded.prepare("SELECT name, public_ip, apps_domain, transport, serves, relay_credential_hash FROM servers").all()).toEqual([
        { name: "old", public_ip: null, apps_domain: null, transport: "direct", serves: 0, relay_credential_hash: null },
      ]);
      expect(upgraded.prepare("SELECT COUNT(*) AS n FROM notifications_default").get()).toEqual({ n: 0 });
      expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    } finally {
      upgraded.close();
    }
  });
});
