import { describe, expect, it } from "vitest";
import { fileEnvironment, fileEnvironmentNote, hasPreviewTemplate } from "@/lib/app-environment-core";

describe("hasPreviewTemplate", () => {
  it("is true only for an app that has a previews: template", () => {
    const model = { apps: [{ name: "shop", image: "i", previews: { domain: "pr-{pr}-shop.example.com" } }, { name: "blog", image: "i" }] };
    expect(hasPreviewTemplate(model, "shop")).toBe(true);
    expect(hasPreviewTemplate(model, "blog")).toBe(false);
    expect(hasPreviewTemplate(model, "other")).toBe(false);
    expect(hasPreviewTemplate({}, "shop")).toBe(false);
    expect(hasPreviewTemplate(undefined, "shop")).toBe(false);
  });
});

describe("fileEnvironment", () => {
  it("names the env_file and the keys of env:, sorted, and never a value", () => {
    const file = fileEnvironment({ env_file: "/srv/shop.env", env: { Z: "secret-1", A: "secret-2" } });
    expect(file).toEqual({ envFile: "/srv/shop.env", envKeys: ["A", "Z"] });
    expect(JSON.stringify(file)).not.toContain("secret");
  });

  it("is empty for an app that sets neither, or one that is unknown", () => {
    expect(fileEnvironment({})).toEqual({ envFile: null, envKeys: [] });
    expect(fileEnvironment({ env_file: "" })).toEqual({ envFile: null, envKeys: [] });
    expect(fileEnvironment(undefined)).toEqual({ envFile: null, envKeys: [] });
  });
});

describe("fileEnvironmentNote", () => {
  it("says nothing when the apps file gives nothing", () => {
    expect(fileEnvironmentNote({ envFile: null, envKeys: [] })).toBeNull();
  });
  it("tells which sources also apply and that the managed value wins", () => {
    expect(fileEnvironmentNote({ envFile: "a.env", envKeys: ["X"] })).toBe("The server's configuration also gives this app env_file a.env and 1 variable in env:. A value saved here wins over the same name there.");
    expect(fileEnvironmentNote({ envFile: null, envKeys: ["X", "Y"] })).toContain("2 variables in env:");
    expect(fileEnvironmentNote({ envFile: "a.env", envKeys: [] })).not.toContain("env:");
  });
});
