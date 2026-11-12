import { describe, expect, it } from "vitest";
import { canRunApps, platformFor, runTargets } from "@/lib/machine-core";

describe("which servers run apps", () => {
  const direct = { transport: "direct" as const, serves: false };
  const server = { transport: "relay" as const, serves: true };
  const laptop = { transport: "relay" as const, serves: false };
  const servers = [
    { id: "a", ...direct },
    { id: "m", ...laptop },
    { id: "s", ...server },
    { id: "b", ...direct },
  ];

  it("leaves out the servers that do not serve, keeping the order of the others", () => {
    expect(runTargets(servers).map((s) => s.id)).toEqual(["a", "s", "b"]);
    expect(servers.map(canRunApps)).toEqual([true, false, true, true]);
  });

  it("treats a direct server as one that runs apps whatever its serves flag says", () => {
    expect(canRunApps({ transport: "direct", serves: true })).toBe(true);
    expect(canRunApps({ transport: "direct", serves: false })).toBe(true);
  });
});

describe("platformFor", () => {
  it.each([
    ["arm64", "linux/arm64"],
    ["amd64", "linux/amd64"],
    [undefined, "linux/amd64"],
    ["riscv64", "linux/amd64"],
  ])("a server of %s gets %s", (arch, platform) => {
    expect(platformFor(arch)).toBe(platform);
  });
});
