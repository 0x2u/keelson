import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isStepUpError } from "@/lib/gate-core";
import type * as AgentModule from "@/lib/agent";
import type * as BinariesModule from "@/lib/agent-binaries";
import { resetStepUp, state } from "./fake-step-up";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-relay-actions-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com";

let anonymous = false;
vi.mock("@/lib/session", () => ({
  requireSession: async () => {
    if (anonymous) throw new Error("NO_SESSION");
  },
  clientInfo: async () => ({ ip: "127.0.0.1" }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/step-up", async () => (await import("./fake-step-up")).fakeStepUp);
// What the server's agent answers, and the version this dashboard carries.
const reported = { version: "" };
const bundled = { version: "v0.2.0" };
vi.mock("@/lib/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentModule>()),
  agentFor: () => ({
    info: async () => {
      if (reported.version === "") throw new Error("the agent on this server is not connected to the dashboard");
      return { version: reported.version, read_only: false };
    },
  }),
}));
vi.mock("@/lib/agent-binaries", async (importOriginal) => ({ ...(await importOriginal<typeof BinariesModule>()), bundledAgentVersion: () => bundled.version }));

const { db } = await import("@/lib/db");
const { connectAddressAction, connectProgressAction, createConnectCodeAction, relayUpdateProgressAction } = await import("@/app/relay-actions");
const { createRelayServer, createServer } = await import("@/lib/servers");
const { consumeRelayCode, openRelayConnection, relayCodeAllowsBinary, relayCodeValid } = await import("@/lib/relay");
const { parseConnection } = await import("@/lib/relay-core");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  resetStepUp();
  anonymous = false;
  for (const table of ["servers", "relay_codes"]) db().exec(`DELETE FROM ${table}`);
});

const relayServer = (name: string, serves = false) => createRelayServer({ name, token: "t".repeat(40), deploySecret: "s".repeat(40), credentialHash: `hash-${name}`, serves });

describe("createConnectCodeAction", () => {
  it("makes a code that is valid, with the install command that carries it and this dashboard's address", async () => {
    const before = Date.now();
    const r = await createConnectCodeAction();
    if (!r.ok) throw new Error(r.error);
    const code = r.code.line.match(/--code (\S+)$/)?.[1] ?? "";
    expect(r.code.line).toBe(`curl -fsSL https://keelson.example.com/install | sudo sh -s -- --code ${code}`);
    expect(relayCodeValid(code)).toBe(true);
    expect(r.code.expiresAt).toBeGreaterThan(before + 29 * 60_000);
    expect(r.code.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(r.code.since).toBeGreaterThanOrEqual(before);
  });

  it("makes the update command for a server that connected this way, with its own fresh code, which can only download the agent", async () => {
    const server = relayServer("vps-1", true);
    const r = await createConnectCodeAction("upgrade", server.id);
    if (!r.ok) throw new Error(r.error);
    const code = r.code.line.match(/--upgrade --code (\S+)$/)?.[1] ?? "";
    expect(r.code.line).toBe(`curl -fsSL https://keelson.example.com/install | sudo sh -s -- --upgrade --code ${code}`);
    expect(relayCodeValid(code)).toBe(true);
    expect(relayCodeAllowsBinary(code)).toBe(true);
    expect(consumeRelayCode(code)).toBe(false);
    expect(db().prepare("SELECT kind, server_id FROM relay_codes").get()).toEqual({ kind: "upgrade", server_id: server.id });
  });

  it("makes no update command for a server that is not there or does not connect out", async () => {
    const direct = createServer({ name: "prod", url: "https://prod.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
    for (const id of [undefined, "nope", direct]) {
      const r = await createConnectCodeAction("upgrade", id);
      expect(r.ok, String(id)).toBe(false);
    }
    expect(db().prepare("SELECT COUNT(*) AS n FROM relay_codes").get()).toEqual({ n: 0 });
  });

  it("still makes the line that connects a computer as a build machine", async () => {
    const r = await createConnectCodeAction("machine");
    if (!r.ok) throw new Error(r.error);
    expect(r.code.line).toContain("https://keelson.example.com/api/relay/binary");
    expect(r.code.line).toContain("keelson-agent connect ksr1.");
    const parsed = parseConnection(r.code.line.match(/ksr1\.[A-Za-z0-9_-]+/)?.[0] ?? "");
    expect(parsed?.url).toBe("https://keelson.example.com");
    expect(relayCodeValid(parsed?.code ?? "")).toBe(true);
  });

  it("will not hand out a line for a dashboard reached over plain http: the machine would send its secrets in the clear", async () => {
    process.env.KEELSON_PUBLIC_URL = "http://keelson.example.com";
    try {
      const r = await createConnectCodeAction();
      expect(r.ok).toBe(false);
      process.env.KEELSON_PUBLIC_URL = "http://localhost:3000";
      expect((await createConnectCodeAction()).ok).toBe(true);
    } finally {
      process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com";
    }
  });

  it("is refused until the session is unlocked, for every kind of line, and makes no code", async () => {
    state.locked = true;
    for (const kind of ["server", "machine", "upgrade"] as const) {
      const r = await createConnectCodeAction(kind);
      expect(r.ok, kind).toBe(false);
      expect(!r.ok && isStepUpError(r.error), kind).toBe(true);
    }
    expect(db().prepare("SELECT COUNT(*) AS n FROM relay_codes").get()).toEqual({ n: 0 });
    expect(state.asked.map((a) => a.verdict.required)).toEqual([true, true, true]);
    state.locked = false;
    expect((await createConnectCodeAction("server")).ok).toBe(true);
  });

  it("is for a signed-in operator only", async () => {
    anonymous = true;
    await expect(createConnectCodeAction()).rejects.toThrow("NO_SESSION");
  });
});

describe("connectProgressAction", () => {
  it("notices the machine that connected after the code was made, and no earlier one or any direct server", async () => {
    relayServer("old-laptop");
    createServer({ name: "prod", url: "https://prod.example.com", token: "t".repeat(40), deploySecret: "s".repeat(40) });
    const since = Date.now() + 1;
    expect(await connectProgressAction(since)).toEqual({ connected: false });
    await new Promise((r) => setTimeout(r, 5));
    const made = relayServer("marc-mac");
    expect(await connectProgressAction(since)).toEqual({ connected: true, serverId: made.id, name: "marc-mac", serves: false });
  });

  it("notices a server that runs apps too, and says so", async () => {
    const since = Date.now();
    const made = relayServer("vps-1", true);
    expect(await connectProgressAction(since)).toEqual({ connected: true, serverId: made.id, name: "vps-1", serves: true });
  });

  it("is for a signed-in operator only", async () => {
    anonymous = true;
    await expect(connectProgressAction(0)).rejects.toThrow("NO_SESSION");
  });
});

describe("connectAddressAction", () => {
  it("says when the command would only work on this machine (loopback address), and not for a public https one", async () => {
    expect(await connectAddressAction()).toEqual({ local: false });
    process.env.KEELSON_PUBLIC_URL = "http://localhost:3000";
    try {
      expect(await connectAddressAction()).toEqual({ local: true });
    } finally {
      process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com";
    }
  });

  it("is for a signed-in operator only", async () => {
    anonymous = true;
    await expect(connectAddressAction()).rejects.toThrow("NO_SESSION");
  });
});

describe("relayUpdateProgressAction", () => {
  const since = Date.now() - 1_000;

  it("is waiting, and says the server does not answer, while its agent is not connected", async () => {
    reported.version = "";
    const server = relayServer("vps-1", true);
    expect(await relayUpdateProgressAction(server.id, since, Date.now())).toEqual({ state: "waiting", running: null });
  });

  it("reports the version the agent runs while it is not the one this dashboard carries, and the update when it is, after a reconnection", async () => {
    const server = relayServer("vps-2", true);
    reported.version = "v0.0.1";
    openRelayConnection(server.id, new AbortController().signal, new Set());
    expect(await relayUpdateProgressAction(server.id, since, Date.now())).toEqual({ state: "waiting", running: "v0.0.1" });
    reported.version = bundled.version;
    expect(await relayUpdateProgressAction(server.id, since, Date.now())).toEqual({ state: "updated", version: bundled.version });
    // The same version on a connection that was made before the command: nothing happened yet.
    expect(await relayUpdateProgressAction(server.id, Date.now() + 60_000, Date.now())).toEqual({ state: "waiting", running: bundled.version });
  });

  it("gives up five minutes after the page began to wait", async () => {
    reported.version = "";
    const server = relayServer("vps-3", true);
    expect(await relayUpdateProgressAction(server.id, since, Date.now() - 5 * 60_000)).toEqual({ state: "timeout", running: null });
  });

  it("is for a signed-in operator only", async () => {
    anonymous = true;
    await expect(relayUpdateProgressAction("x", 0, 0)).rejects.toThrow("NO_SESSION");
  });
});
