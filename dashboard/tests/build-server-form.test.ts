import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BuildLimits } from "@/lib/agent-types";
import type { BuildServerChoice } from "@/lib/build-elsewhere-core";
import type { ServerStats } from "@/lib/server-stats-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-build-server-form-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { BuildServerForm } = await import("@/components/repository/BuildServerForm");

const GB = 1024 ** 3;
const limits: BuildLimits = { memory: 4 * GB, cpus: 8, timeout_seconds: 3600, max_source: 2 * GB, source_hosts: ["codeload.github.com"], host_network: false, keep_images: 3 };
const server = (available: number, total: number, extra: Partial<ServerStats> = {}): ServerStats => ({ online: true, cpus: 4, load1: 0.5, memTotal: total * GB, memAvailable: available * GB, diskFree: 50 * GB, build: limits, ...extra });
const choice = (over: Partial<BuildServerChoice> & { serverId: string; name: string }): BuildServerChoice => ({ stats: server(11, 16), disabled: null, note: null, ...over });

const render = (props: Partial<Parameters<typeof BuildServerForm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(BuildServerForm, {
      serverId: "vps-1",
      ownName: "vps-1",
      ownStats: server(1.2, 3.8),
      ownMemory: "3g",
      app: "shop",
      current: null,
      choices: [choice({ serverId: "big", name: "big-box" })],
      notSent: { stored: [], hidden: [] },
      buildVars: { big: { names: [] } },
      ...props,
    }),
  );

describe("the build server chooser", () => {
  it("is one radio per server, this one first, each with its numbers and what it takes", () => {
    const out = render();
    expect(out.match(/type="radio"/g)).toHaveLength(2);
    expect(out.indexOf("This server builds and runs it")).toBeLessThan(out.indexOf("big-box"));
    expect(out).toContain("4 CPUs");
    expect(out).toContain("11 GB of 16 GB RAM free");
    expect(out).toContain("Takes builds: up to 4.0 GB of memory");
  });

  it("says which server cannot hold a build of that size right now", () => {
    const out = render({ choices: [choice({ serverId: "big", name: "big-box", stats: server(1.2, 16) })] });
    expect(out).toContain("Not enough free memory for a 3.0 GB build right now.");
  });

  it("marks the saved choice, keeps a server that is no longer registered visible, and holds the choice in the form", () => {
    const out = render({ current: "gone" });
    expect(out).toContain('name="builder" value="gone"');
    expect(out).toContain("No longer registered in this dashboard");
    expect(out).toContain("This server is not registered here any more");
  });

  it("shows a server that cannot take the build as disabled, with the reason", () => {
    const out = render({ choices: [choice({ serverId: "old", name: "old-box", stats: server(8, 16, { build: undefined }), disabled: "Update the agent on old-box: it cannot build for other servers yet." })] });
    expect(out).toContain("Update the agent on old-box");
    expect(out).toMatch(/<input type="radio"[^>]*disabled/);
  });

  it("shows a server that does not answer without numbers to compare", () => {
    const out = render({ choices: [choice({ serverId: "big", name: "big-box", stats: { online: false }, disabled: "big-box is not answering: start its agent, then choose it." })] });
    expect(out).toContain("not answering");
  });

  it("notes a builder of another architecture", () => {
    const out = render({
      choices: [
        choice({
          serverId: "arm",
          name: "arm-box",
          note: "The image is built for linux/amd64 (where it runs) on a linux/arm64 server: Docker does that through emulation, which is slower.",
        }),
      ],
    });
    expect(out).toContain("through emulation");
  });
  it("warns, before saving, about the build values that would not reach another server, only while one is chosen, with a link to its build variables", () => {
    const notSent = {
      stored: ["NEXT_PUBLIC_API"],
      hidden: ["REGISTRY_AUTH_TOKEN"],
    };
    expect(render({ notSent })).not.toContain("Build values are not sent");
    const out = render({ current: "big", notSent });
    expect(out).toContain("Build values are not sent");
    expect(out).toContain("NEXT_PUBLIC_API");
    expect(out).toContain("REGISTRY_AUTH_TOKEN");
    expect(out).toContain("big-box");
    expect(out).toContain('href="#build-variables"');
  });

  it("stops warning about the names the chosen builder already keeps", () => {
    const notSent = {
      stored: ["NEXT_PUBLIC_API"],
      hidden: ["REGISTRY_AUTH_TOKEN"],
    };
    const t = "2026-11-03T10:00:00Z";
    const some = render({
      current: "big",
      notSent,
      buildVars: {
        big: { names: [{ name: "NEXT_PUBLIC_API", changed_at: t }] },
      },
    });
    expect(some).toContain("Build values are not sent");
    expect(some).toContain("REGISTRY_AUTH_TOKEN in build.args is a secret");
    expect(some).not.toContain("The build variables of shop (NEXT_PUBLIC_API)");
    const all = render({
      current: "big",
      notSent,
      buildVars: {
        big: {
          names: [
            { name: "NEXT_PUBLIC_API", changed_at: t },
            { name: "REGISTRY_AUTH_TOKEN", changed_at: t },
          ],
        },
      },
    });
    expect(all).not.toContain("Build values are not sent");
  });
});

describe("the build variables of the chosen server", () => {
  const t = "2026-11-03T10:00:00Z";
  it("has no section while the app's own server is chosen", () => {
    const out = render({ notSent: { stored: ["A"], hidden: [] } });
    expect(out).not.toContain("Build variables on");
    expect(out).not.toContain('id="build-variables"');
  });

  it("replaces the dead end by an actionable section for the builder: its names, write-only, the app's own not used, and the names to copy", () => {
    const out = render({
      current: "big",
      notSent: { stored: ["DATABASE_URL", "NEXT_PUBLIC_API"], hidden: [] },
      buildVars: { big: { names: [{ name: "DATABASE_URL", changed_at: t }] } },
    });
    expect(out).toContain('id="build-variables"');
    expect(out).toContain("Build variables on big-box");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("NOT used by a build on big-box");
    expect(out).toContain("stored on vps-1");
    expect(out).toContain("Copy the names (1)");
    expect(out).toContain("Paste a .env");
    expect(out).toContain("Save on big-box");
    expect(out).toContain("Replace");
    // The warning before building names only what the builder lacks, and is not the dead end it was: it links to the section.
    expect(out).toContain("Build values are not sent");
    expect(out).not.toContain("The build variables of shop (DATABASE_URL");
  });

  it("offers nothing to copy once the builder has every name, and says when it keeps none", () => {
    expect(
      render({
        current: "big",
        notSent: { stored: ["A"], hidden: [] },
        buildVars: { big: { names: [{ name: "A", changed_at: t }] } },
      }),
    ).not.toContain("Copy the names");
    expect(
      render({ current: "big", buildVars: { big: { names: [] } } }),
    ).toContain("keeps no build variable for shop yet");
  });

  it("says why it cannot be read instead of listing names", () => {
    const out = render({
      current: "big",
      notSent: { stored: ["A"], hidden: [] },
      buildVars: {
        big: {
          error:
            "This agent is too old to keep build variables for other servers.",
        },
      },
    });
    expect(out).toContain("Could not read big-box");
    expect(out).toContain("too old to keep build variables");
    expect(out).not.toContain("Copy the names");
  });

  it("never puts a value in the page: values are typed in a password field and not part of what the page carries", () => {
    const out = render({
      current: "big",
      notSent: { stored: ["A"], hidden: [] },
      buildVars: { big: { names: [] } },
    });
    expect(out).not.toMatch(/type="password"[^>]*value="[^"]/);
  });
});
