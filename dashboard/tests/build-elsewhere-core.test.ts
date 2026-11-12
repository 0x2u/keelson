import { describe, expect, it } from "vitest";
import { HIDDEN, type AppConfig, type BuildLimits } from "@/lib/agent-types";
import {
  buildChoices,
  buildRequestFor,
  buildVarsView,
  describeLimits,
  limitRefusal,
  missingOnBuilder,
  notSentWarning,
  parseDurationSeconds,
  parseSize,
} from "@/lib/build-elsewhere-core";
import type { ServerStats } from "@/lib/server-stats-core";

const GIB = 1024 ** 3;
const limits: BuildLimits = { memory: 2 * GIB, cpus: 4, timeout_seconds: 1800, max_source: GIB, source_hosts: ["codeload.github.com", "api.github.com"], host_network: false, keep_images: 3 };

const shop: AppConfig = {
  name: "shop",
  image: "keelson-local/shop:abc123",
  port: 3000,
  domains: ["shop.example.com"],
  env: { A: "1" },
  health_path: "/up",
  release: { steps: [] },
  build: {
    dockerfile: "Dockerfile.keelson",
    context: "web",
    memory: "1g",
    cpus: 2,
    args: { NEXT_PUBLIC_X: "y" },
    database: true,
    network: "shop-net",
  },
};
const source = {
  url: "https://codeload.github.com/o/r/tar.gz/abc",
  token: "ghs_x",
};
const ask = (
  app: AppConfig,
  targetArch = "amd64",
  builderArch = "amd64",
  builderLimits: BuildLimits = limits,
) =>
  buildRequestFor(app, {
    sha: "a".repeat(40),
    source,
    targetArch,
    builderArch,
    builder: { name: "mac", limits: builderLimits },
  });

describe("sizes and durations", () => {
  it.each([
    ["3g", 3 * GIB],
    ["512m", 512 * 1024 ** 2],
    ["2048", 2048],
    ["1GiB", GIB],
  ])("reads the size %s", (text, bytes) => expect(parseSize(text)).toBe(bytes));
  it.each([["", null], ["lots", null], ["-1g", null]])("does not read the size %j", (text, out) => expect(parseSize(text)).toBe(out));
  it.each([
    ["30m", 1800],
    ["1h30m", 5400],
    ["90s", 90],
  ])("reads the duration %s", (text, seconds) => expect(parseDurationSeconds(text)).toBe(seconds));
  it("does not read an unfinished duration", () => expect(parseDurationSeconds("30")).toBeNull());
});

describe("buildRequestFor", () => {
  it("carries the app's block without what names its own server, under the image's repository", () => {
    const r = ask(shop);
    if (!r.ok) throw new Error(r.error);
    expect(r.request).toEqual({
      app: "shop",
      image: "keelson-local/shop",
      sha: "a".repeat(40),
      source,
      build: { dockerfile: "Dockerfile.keelson", context: "web", memory: "1g", cpus: 2, args: { NEXT_PUBLIC_X: "y" } },
    });
  });

  it("builds for the architecture of the server that runs the app, only when the builder's differs", () => {
    const r = ask(shop, "amd64", "arm64");
    expect(r.ok && r.request.build.platform).toBe("linux/amd64");
    const same = ask(shop, "arm64", "arm64");
    expect(same.ok && same.request.build.platform).toBeUndefined();
    const unknownTarget = buildRequestFor(shop, {
      sha: "a".repeat(40),
      source,
      targetArch: undefined,
      builderArch: "arm64",
      builder: { name: "mac", limits },
    });
    expect(
      unknownTarget.ok && unknownTarget.request.build.platform,
    ).toBeUndefined();
  });

  it("keeps a platform the block sets itself", () => {
    const r = ask({ ...shop, build: { ...shop.build, platform: "linux/arm64" } }, "amd64", "arm64");
    expect(r.ok && r.request.build.platform).toBe("linux/arm64");
  });

  it("keeps the port and health path a framework preset writes into the image, only then", () => {
    const preset = ask({ ...shop, build: { preset: "nextjs" } });
    expect(preset.ok && [preset.request.port, preset.request.health_path]).toEqual([3000, "/up"]);
    const dockerfile = ask(shop);
    expect(dockerfile.ok && [dockerfile.request.port, dockerfile.request.health_path]).toEqual([undefined, undefined]);
  });

  it("takes the repository of a registry image with a port, not the port for a tag", () => {
    const r = ask({ ...shop, image: "registry.local:5000/team/shop:1" });
    expect(r.ok && r.request.image).toBe("registry.local:5000/team/shop");
  });

  it("leaves out the build arguments the configuration hides and names them", () => {
    const r = ask({ ...shop, build: { preset: "node", args: { NEXT_PUBLIC_X: "y", REGISTRY_AUTH_TOKEN: HIDDEN } } });
    if (!r.ok) throw new Error(r.error);
    expect(r.request.build.args).toEqual({ NEXT_PUBLIC_X: "y" });
    expect(r.hiddenArgs).toEqual(["REGISTRY_AUTH_TOKEN"]);
    expect(JSON.stringify(r.request)).not.toContain(HIDDEN);
  });

  it("sends no args at all when every one is hidden", () => {
    const r = ask({ ...shop, build: { preset: "node", args: { A_TOKEN: HIDDEN } } });
    expect(r.ok && "args" in r.request.build).toBe(false);
  });

  it("refuses an app without a build block, saying so", () => {
    const r = ask({ ...shop, build: undefined });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no build: block") });
  });

  describe("network", () => {
    const host = { ...shop, build: { ...shop.build, network: "host" } };
    it("sends `network: host` to a builder that allows host-network builds, and still drops the database", () => {
      const r = ask(host, "amd64", "amd64", { ...limits, host_network: true });
      if (!r.ok) throw new Error(r.error);
      expect(r.request.build).toEqual({
        dockerfile: "Dockerfile.keelson",
        context: "web",
        memory: "1g",
        cpus: 2,
        args: { NEXT_PUBLIC_X: "y" },
        network: "host",
      });
    });
    it("refuses before sending when the builder does not allow it, with the builder's own words", () => {
      expect(ask(host)).toEqual({
        ok: false,
        error:
          "mac does not allow host-network builds (build_limits.host_network: true)",
      });
    });
    it("drops a named network: it names a Docker network of the app's own server", () => {
      for (const allowed of [false, true]) {
        const r = ask(shop, "amd64", "amd64", {
          ...limits,
          host_network: allowed,
        });
        expect(r.ok && "network" in r.request.build).toBe(false);
      }
    });
    it("asks nothing of the builder for a block without a network", () => {
      const r = ask({ ...shop, build: { preset: "static" } });
      expect(r.ok && "network" in r.request.build).toBe(false);
    });
  });
});

describe("limitRefusal", () => {
  it("accepts a block within every limit, and one that states none", () => {
    expect(limitRefusal({ memory: "2g", cpus: 4, timeout: "30m", max_source: "1g", source_hosts: ["codeload.github.com"] }, limits)).toBeNull();
    expect(limitRefusal({ preset: "node" }, limits)).toBeNull();
  });

  it.each([
    [{ memory: "3g" }, "build.memory"],
    [{ cpus: 8 }, "build.cpus"],
    [{ timeout: "2h" }, "build.timeout"],
    [{ max_source: "2g" }, "build.max_source"],
    [{ source_hosts: ["git.example.com"] }, "build.source_hosts git.example.com"],
  ])("names the limit a block above it asks too much of: %j", (block, named) => {
    expect(limitRefusal(block, limits)).toContain(named);
  });

  it("has no memory ceiling at 0", () => {
    expect(limitRefusal({ memory: "64g" }, { ...limits, memory: 0 })).toBeNull();
  });

  it("refuses `network: host` where build_limits.host_network is off, and accepts it where it is on", () => {
    expect(limitRefusal({ network: "host" }, limits)).toContain(
      "build_limits.host_network: true",
    );
    expect(
      limitRefusal({ network: "host" }, { ...limits, host_network: true }),
    ).toBeNull();
    expect(limitRefusal({ network: "shop-net" }, limits)).toBeNull();
  });
});

describe("notSentWarning", () => {
  const names = {
    app: "shop",
    ownName: "vps-1",
    buildServer: "mac",
    onBuilder: [] as string[],
  };
  it("is silent when nothing stays behind", () =>
    expect(notSentWarning({ stored: [], hidden: [] }, names)).toBeNull());
  it("names the stored build variables, says a build elsewhere does not use them and links to the builder's build variables", () => {
    const w = notSentWarning(
      { stored: ["NEXT_PUBLIC_API", "NEXT_PUBLIC_DSN"], hidden: [] },
      names,
    );
    expect(w?.body).toContain("NEXT_PUBLIC_API, NEXT_PUBLIC_DSN");
    expect(w?.body).toContain("stored on vps-1");
    expect(w?.body).toContain("does not use them");
    expect(w?.body).toContain("put them in the build variables of mac");
    expect(w?.body).not.toContain("hidden");
    expect(w?.href).toBe("#build-variables");
  });
  it("names the hidden build arguments apart and says to put them in the builder's build variables", () => {
    const w = notSentWarning(
      { stored: [], hidden: ["REGISTRY_AUTH_TOKEN"] },
      names,
    );
    expect(w?.body).toContain("REGISTRY_AUTH_TOKEN in build.args is a secret");
    expect(w?.body).toContain("put it in the build variables of mac");
  });
  it("only warns about the names the builder does not have, and is silent once it has them all", () => {
    const n = {
      stored: ["DATABASE_URL", "NEXT_PUBLIC_API"],
      hidden: ["REGISTRY_AUTH_TOKEN"],
    };
    const some = notSentWarning(n, { ...names, onBuilder: ["DATABASE_URL"] });
    expect(some?.body).toContain("NEXT_PUBLIC_API");
    expect(some?.body).toContain("REGISTRY_AUTH_TOKEN");
    expect(some?.body).not.toContain("DATABASE_URL");
    expect(
      notSentWarning(n, {
        ...names,
        onBuilder: [
          "DATABASE_URL",
          "NEXT_PUBLIC_API",
          "REGISTRY_AUTH_TOKEN",
          "OTHER",
        ],
      }),
    ).toBeNull();
  });
});

describe("the builder's build variables", () => {
  const stamp = (name: string) => ({
    name,
    changed_at: "2026-11-03T10:00:00Z",
  });
  const base = { app: "shop", ownName: "vps-1", builder: "mac" };

  it("lists what the builder keeps and says nothing about the app's own server when it stores none", () => {
    const v = buildVarsView({
      ...base,
      read: { names: [stamp("DATABASE_URL")] },
      notSent: { stored: [], hidden: [] },
    });
    expect(v.title).toBe("Build variables on mac");
    expect(v.names.map((n) => n.name)).toEqual(["DATABASE_URL"]);
    expect(v.ownNote).toBeNull();
    expect(v.missing).toEqual([]);
    expect(v.readError).toBeNull();
    expect(v.intro).toContain("Write-only");
  });

  it("says plainly that the app's own stored build variables are not used, names them, and offers the names the builder lacks", () => {
    const v = buildVarsView({
      ...base,
      read: { names: [stamp("DATABASE_URL")] },
      notSent: {
        stored: ["NEXT_PUBLIC_API", "DATABASE_URL"],
        hidden: ["REGISTRY_AUTH_TOKEN"],
      },
    });
    expect(v.ownNote).toContain("stored on vps-1");
    expect(v.ownNote).toContain("DATABASE_URL, NEXT_PUBLIC_API");
    expect(v.ownNote).toContain("NOT used by a build on mac");
    expect(v.missing).toEqual(["NEXT_PUBLIC_API", "REGISTRY_AUTH_TOKEN"]);
  });

  it("shows a server that keeps none yet, with every wanted name offered", () => {
    const v = buildVarsView({
      ...base,
      read: { names: [] },
      notSent: { stored: ["B", "A"], hidden: [] },
    });
    expect(v.names).toEqual([]);
    expect(v.missing).toEqual(["A", "B"]);
  });

  it("says why the names could not be read, and offers no placeholder then", () => {
    const v = buildVarsView({
      ...base,
      read: {
        error:
          "This agent is too old to keep build variables for other servers.",
      },
      notSent: { stored: ["A"], hidden: [] },
    });
    expect(v.readError).toContain("too old");
    expect(v.names).toEqual([]);
    expect(v.missing).toEqual([]);
    expect(v.ownNote).toContain("A");
  });

  it("carries no value anywhere: the view is made of names and times", () => {
    const v = buildVarsView({
      ...base,
      read: { names: [stamp("DATABASE_URL")] },
      notSent: { stored: ["A"], hidden: [] },
    });
    expect(Object.keys(v.names[0]!).sort()).toEqual(["changed_at", "name"]);
  });

  it("counts a name once and sorts what is missing", () => {
    expect(
      missingOnBuilder({ stored: ["B", "A"], hidden: ["A", "C"] }, ["C"]),
    ).toEqual(["A", "B"]);
  });
});

describe("buildChoices", () => {
  const online = (extra: Partial<ServerStats> = {}): ServerStats => ({ online: true, arch: "amd64", build: limits, ...extra });
  const server = (id: string, stats: ServerStats, canDeploy = true) => ({ id, name: id, canDeploy, stats });
  const block = { preset: "node" as const, memory: "1g" };

  it("offers a server that answers with the build section, and warns about emulation when the architectures differ", () => {
    const [same, other] = buildChoices([server("a", online()), server("b", online({ arch: "arm64" }))], block, "amd64");
    expect([same.disabled, same.note]).toEqual([null, null]);
    expect(other.disabled).toBeNull();
    expect(other.note).toContain("emulation");
  });

  it("disables an agent without the build section: update the agent", () => {
    const [c] = buildChoices([server("old", online({ build: undefined }))], block, "amd64");
    expect(c.disabled).toMatch(/Update the agent on old/);
  });

  it("disables a server that does not answer, and one without a deploy secret", () => {
    const [off, nosecret] = buildChoices([server("off", { online: false }), server("nosecret", online(), false)], block, "amd64");
    expect(off.disabled).toContain("not answering");
    expect(nosecret.disabled).toContain("deploy secret");
  });

  it("disables a server whose limits the block is above, naming the limit", () => {
    const [c] = buildChoices([server("small", online({ build: { ...limits, memory: GIB / 2 } }))], block, "amd64");
    expect(c.disabled).toContain("build.memory 1g");
  });

  it("disables a server that does not allow the host network when the block asks for it, and offers one that does", () => {
    const [refuses, allows] = buildChoices(
      [
        server("closed", online()),
        server("open", online({ build: { ...limits, host_network: true } })),
      ],
      { ...block, network: "host" },
      "amd64",
    );
    expect(refuses.disabled).toContain("closed refuses this build");
    expect(refuses.disabled).toContain("build_limits.host_network: true");
    expect(allows.disabled).toBeNull();
  });

  it("disables everything for an app without a build block", () => {
    const [c] = buildChoices([server("a", online())], undefined, "amd64");
    expect(c.disabled).toContain("no build: block");
  });
});

describe("describeLimits", () => {
  it("says what the server takes on one line", () => {
    expect(describeLimits(limits)).toBe("up to 2.0 GB of memory · up to 4 CPUs · 30 min per build · sources up to 1.0 GB");
    expect(describeLimits({ ...limits, memory: 0, host_network: true })).toContain("no memory ceiling");
  });
});
