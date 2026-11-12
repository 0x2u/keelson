import { describe, expect, it } from "vitest";
import { parseImport } from "@/lib/server-import-core";

const TOKEN = "t".repeat(40);

function parse(servers: unknown) {
  const r = parseImport(JSON.stringify({ servers }));
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

describe("parseImport", () => {
  it("reads an agent that already runs and an address the agent is not on yet", () => {
    const rows = parse([
      { name: "local", url: "http://127.0.0.1:7070/", token: TOKEN },
      { name: "vps-2", ssh: { host: "203.0.113.7", port: 2222, user: "debian" } },
    ]);
    expect(rows[0].entry).toMatchObject({ kind: "agent", values: { name: "local", url: "http://127.0.0.1:7070/", token: TOKEN, deploySecret: "" } });
    expect(rows[1].entry).toEqual({ kind: "ssh", name: "vps-2", host: "203.0.113.7", port: "2222", user: "debian" });
  });

  it("gives an ssh entry the installer's own defaults", () => {
    expect(parse([{ name: "vps", ssh: { host: "vps.example.com" } }])[0].entry).toMatchObject({ port: "22", user: "root" });
  });

  it("refuses what the add form would refuse, with the reason", () => {
    const rows = parse([
      { name: "short", url: "http://127.0.0.1:7070", token: "abc" },
      { name: "bad-url", url: "agent.example.com", token: TOKEN },
      { name: "same", url: "http://127.0.0.1:7070", token: TOKEN, deploy_secret: TOKEN },
      { name: "bad-host", ssh: { host: "not a host!", port: 99999 } },
    ]);
    expect(rows.map((r) => r.error !== undefined)).toEqual([true, true, true, true]);
    expect(rows[0].error).toMatch(/at least 32/i);
    expect(rows[2].error).toMatch(/differ/i);
    expect(rows[3].error).toMatch(/host name/);
  });

  it("catches a typo in a key instead of dropping the setting", () => {
    const rows = parse([{ name: "x", url: "http://127.0.0.1:7070", token: TOKEN, deploySecret: TOKEN + "x" }]);
    expect(rows[0].error).toMatch(/unknown key "deploySecret"/);
  });

  it("does not coerce a number into a token", () => {
    expect(parse([{ name: "x", url: "http://127.0.0.1:7070", token: 123456 }])[0].error).toMatch(/token must be a string/);
  });

  it("refuses an entry that is both an agent and an install target", () => {
    expect(parse([{ name: "x", url: "http://127.0.0.1:7070", token: TOKEN, ssh: { host: "h.example.com" } }])[0].error).toMatch(/cannot also have/);
  });

  it("refuses a name used twice, keeping the first", () => {
    const rows = parse([
      { name: "a", url: "http://127.0.0.1:7070", token: TOKEN },
      { name: "a", url: "http://127.0.0.1:7071", token: TOKEN },
    ]);
    expect(rows[0].error).toBeUndefined();
    expect(rows[1].error).toMatch(/twice/);
  });

  it("rejects a file that is not the expected shape", () => {
    expect(parseImport("{nope")).toMatchObject({ ok: false });
    expect(parseImport("[]")).toMatchObject({ ok: false });
    expect(parseImport('{"servers": []}')).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(parseImport('{"servers": [{"name":"x","url":"http://h","token":"t"}], "extra": 1}')).toMatchObject({ ok: false, error: expect.stringMatching(/extra/) });
  });
});
