import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledAgentVersion, dashboardVersion } from "@/lib/agent-binaries";
import { agentUpdate, offersUpdate, parseVersion, releaseNotesUrl, type AgentUpdate } from "@/lib/agent-binaries-core";
import { upgradeCommand } from "@/lib/ssh-install-core";

describe("reading a version", () => {
  const parse = (text: string) => parseVersion(text);
  it("reads tags, versions between tags, dirty trees and pre-releases", () => {
    expect(parse("v0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [], commits: 0, hash: null, dirty: false });
    expect(parse("0.12.3\n")).toMatchObject({ major: 0, minor: 12, patch: 3 });
    expect(parse("v0.3.0-4-gabc1234")).toMatchObject({ patch: 0, prerelease: [], commits: 4, hash: "abc1234", dirty: false });
    expect(parse("v0.3.0-4-gabc1234-dirty")).toMatchObject({ commits: 4, hash: "abc1234", dirty: true });
    expect(parse("v0.3.0-dirty")).toMatchObject({ commits: 0, hash: null, dirty: true });
    expect(parse("v0.2.0-rc.1")).toMatchObject({ prerelease: ["rc", "1"], commits: 0 });
    expect(parse("v0.2.0-rc.1-12-g1a2b3c4d-dirty")).toMatchObject({ prerelease: ["rc", "1"], commits: 12, hash: "1a2b3c4d", dirty: true });
    expect(parse("v1.0.0-3-gabcdef0")?.prerelease).toEqual([]);
  });

  it("does not read what is not a version: hashes, dev builds, partial or padded numbers", () => {
    for (const text of ["dev", "dev-1a2b3c4", "1a2b3c4", "abc1234-dirty", "v1", "v1.2", "v1.2.x", "v01.2.3", "v1.2.3.4", "v1.2.3+build", "v1.2.3-", "latest", ""]) expect(parse(text), text).toBeNull();
  });
});

describe("telling whether a server runs the agent this dashboard carries", () => {
  // [agent on the server, agent the dashboard carries, verdict]
  const table: Array<[string, string, AgentUpdate]> = [
    // releases
    ["v0.1.0", "v0.1.0", "current"],
    ["v0.1.0", "v0.1.1", "older"],
    ["v0.1.1", "v0.1.0", "newer"],
    ["v0.9.0", "v0.10.0", "older"],
    ["v1.0.0", "v0.99.99", "newer"],
    ["v0.1.0", "0.1.0", "current"],
    // between tags
    ["v0.3.0-4-gabc1234", "v0.3.0-4-gabc1234", "current"],
    ["v0.3.0-4-gabc1234-dirty", "v0.3.0-4-gabc1234-dirty", "current"],
    ["v0.3.0", "v0.3.0-2-gabc1234", "older"],
    ["v0.3.0-2-gabc1234", "v0.3.0", "newer"],
    ["v0.3.0-2-gabc1234", "v0.3.0-9-gdef5678", "older"],
    ["v0.3.0-10-gabc1234", "v0.3.0-9-gdef5678", "newer"],
    ["v0.2.9-50-gabc1234", "v0.3.0", "older"],
    ["v0.3.0-1-gabc1234", "v0.3.1", "older"],
    // same commit count but not the same commit, or a dirty tree: no order
    ["v0.3.0-4-gabc1234", "v0.3.0-4-gdef5678", "different"],
    ["v0.3.0-4-gabc1234", "v0.3.0-4-gabc1234-dirty", "different"],
    ["v0.3.0", "v0.3.0-dirty", "different"],
    ["v0.3.0-dirty", "v0.3.0-1-gabc1234", "older"],
    // pre-releases sort below their release and by identifier
    ["v0.2.0-rc.1", "v0.2.0", "older"],
    ["v0.2.0", "v0.2.0-rc.1", "newer"],
    ["v0.2.0-rc.1", "v0.2.0-rc.2", "older"],
    ["v0.2.0-rc.10", "v0.2.0-rc.2", "newer"],
    ["v0.2.0-alpha", "v0.2.0-beta", "older"],
    ["v0.2.0-rc", "v0.2.0-rc.1", "older"],
    ["v0.2.0-rc.1-3-gabc1234", "v0.2.0-rc.1", "newer"],
    ["v0.2.0-rc.1-3-gabc1234", "v0.2.0", "older"],
    ["v0.1.9", "v0.2.0-rc.1", "older"],
    // build names without a version have no order: a different one is offered, as before
    ["dev", "dev", "current"],
    ["abc1234", "abc1234", "current"],
    ["abc1234", "def5678", "different"],
    ["dev-abc1234", "dev-def5678", "different"],
    ["dev", "v0.1.0", "different"],
    ["v0.1.0", "dev-abc1234", "different"],
    ["v0.1.0-3-gabc1234", "def5678", "different"],
  ];
  it.each(table)("agent %s, dashboard %s: %s", (agent, dashboard, verdict) => {
    expect(agentUpdate(agent, dashboard)).toBe(verdict);
  });

  it("only offers an update when the agent is behind, or differs in a way with no order, never for a newer one", () => {
    expect(offersUpdate("older")).toBe(true);
    expect(offersUpdate("different")).toBe(true);
    expect(offersUpdate("newer")).toBe(false);
    expect(offersUpdate("current")).toBe(false);
    expect(offersUpdate("unknown")).toBe(false);
  });

  it("says unknown when either side is missing, never 'different'", () => {
    expect(agentUpdate("", "v0.3.0")).toBe("unknown");
    expect(agentUpdate("v0.3.0", null)).toBe("unknown");
    expect(agentUpdate("  ", "  ")).toBe("unknown");
  });

  it("ignores surrounding whitespace, such as the newline of the VERSION file", () => {
    expect(agentUpdate("v0.3.0", "v0.3.0\n")).toBe("current");
    expect(agentUpdate(" v0.3.0 ", "v0.3.1\n")).toBe("older");
  });
});

describe("the release notes link", () => {
  it("is offered for a published tag only", () => {
    expect(releaseNotesUrl("v0.1.0")).toBe("https://github.com/0x2u/keelson/releases/tag/v0.1.0");
    expect(releaseNotesUrl("v0.2.0-rc.1\n")).toBe("https://github.com/0x2u/keelson/releases/tag/v0.2.0-rc.1");
    for (const version of ["v0.1.0-3-gabc1234", "v0.1.0-dirty", "0.1.0", "dev", "dev-abc1234", "abc1234", "", null]) expect(releaseNotesUrl(version), String(version)).toBeNull();
  });
});

describe("this dashboard's own version", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the one the image was built with, or dev outside an image", () => {
    vi.stubEnv("KEELSON_DASHBOARD_VERSION", "v0.1.0\n");
    expect(dashboardVersion()).toBe("v0.1.0");
    vi.stubEnv("KEELSON_DASHBOARD_VERSION", "");
    expect(dashboardVersion()).toBe("dev");
  });

  it("is read from the VERSION file next to the binaries for the agent it carries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keelson-bin-"));
    try {
      vi.stubEnv("KEELSON_AGENT_BIN_DIR", dir);
      expect(bundledAgentVersion()).toBeNull();
      writeFileSync(path.join(dir, "VERSION"), "v0.1.0\n");
      expect(bundledAgentVersion()).toBe("v0.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the upgrade command", () => {
  it("carries no setting of its own: the installation remembers them", () => {
    for (const sudo of ["root", "passwordless", undefined] as const) {
      const cmd = upgradeCommand("/tmp/keelson-install.abc", sudo ?? "passwordless");
      expect(cmd).toContain("install --upgrade");
      for (const flag of ["--host", "--listen", "--name", "--nginx", "--allow-from"]) expect(cmd).not.toContain(flag);
    }
  });

  it("runs as root, with sudo's password on stdin when it asks for one, never in the command", () => {
    expect(upgradeCommand("/tmp/d", "root")).toBe("'/tmp/d'/keelson-agent install --upgrade");
    expect(upgradeCommand("/tmp/d", "passwordless")).toBe("sudo -n '/tmp/d'/keelson-agent install --upgrade");
    const asked = upgradeCommand("/tmp/d", "hunter2");
    expect(asked).toBe("sudo -S -p '' '/tmp/d'/keelson-agent install --upgrade");
    expect(asked).not.toContain("hunter2");
  });
});
