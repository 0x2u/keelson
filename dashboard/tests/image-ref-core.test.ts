import { describe, expect, it } from "vitest";
import { middleTruncate, splitRef, versionOf } from "@/lib/image-ref-core";

const D = "ab".repeat(32);

describe("splitRef", () => {
  it("separates the repository from the tag", () => {
    expect(splitRef("ghcr.io/me/web:v1.4.2")).toEqual({ repository: "ghcr.io/me/web", tag: "v1.4.2" });
    expect(splitRef("nginx:alpine")).toEqual({ repository: "nginx", tag: "alpine" });
  });
  it("is not fooled by a registry port", () => {
    expect(splitRef("localhost:5000/web")).toEqual({ repository: "localhost:5000/web" });
    expect(splitRef("localhost:5000/web:v2")).toEqual({ repository: "localhost:5000/web", tag: "v2" });
  });
  it("shortens a digest to 12 characters, alone or after a tag", () => {
    expect(splitRef(`ghcr.io/me/web@sha256:${D}`)).toEqual({ repository: "ghcr.io/me/web", digest: "abababababab" });
    expect(splitRef(`web:v3@sha256:${D}`)).toEqual({ repository: "web", tag: "v3", digest: "abababababab" });
  });
});

describe("versionOf", () => {
  it("is the tag, else the short digest, else latest", () => {
    expect(versionOf("a/b:v3")).toBe("v3");
    expect(versionOf(`a/b@sha256:${D}`)).toBe("abababababab");
    expect(versionOf("a/b")).toBe("latest");
  });
});

describe("middleTruncate", () => {
  it("leaves short text and cuts long text in the middle, keeping both ends", () => {
    expect(middleTruncate("ghcr.io/me/web")).toBe("ghcr.io/me/web");
    const cut = middleTruncate("registry.example.com/team/platform/services/checkout-api", 30);
    expect(cut.length).toBe(30);
    expect(cut.startsWith("registry.")).toBe(true);
    expect(cut.endsWith("checkout-api")).toBe(true);
    expect(cut).toContain("…");
  });
});

describe("deployInput", () => {
  it("is the tag, else the whole digest, else nothing exact", async () => {
    const { deployInput } = await import("@/lib/image-ref-core");
    expect(deployInput("r/web:v3")).toBe("v3");
    expect(deployInput(`r/web@sha256:${D}`)).toBe(`sha256:${D}`);
    expect(deployInput("r/web")).toBe("");
  });
});
