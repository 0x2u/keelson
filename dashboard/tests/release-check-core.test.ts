import { describe, expect, it } from "vitest";
import { NOTES_MAX, parseLatestRelease, releaseStatus, updateCommand, type Release, type ReleaseStatus } from "@/lib/release-check-core";

const release = (tag: string): Release => ({ tag, url: `https://github.com/0x2u/keelson/releases/tag/${tag}`, publishedAt: null, notes: "" });

describe("parsing GitHub's releases/latest", () => {
  const body = { tag_name: "v0.2.0", html_url: "https://github.com/0x2u/keelson/releases/tag/v0.2.0", published_at: "2026-11-01T10:00:00Z", prerelease: false, draft: false, body: "\n  Fixes.  \n" };

  it("reads the tag, the page, the date and the trimmed text", () => {
    expect(parseLatestRelease(body)).toEqual({ tag: "v0.2.0", url: body.html_url, publishedAt: "2026-11-01T10:00:00Z", notes: "Fixes." });
  });

  it("never offers a pre-release or a draft, flagged or named like one", () => {
    expect(parseLatestRelease({ ...body, prerelease: true })).toBeNull();
    expect(parseLatestRelease({ ...body, draft: true })).toBeNull();
    expect(parseLatestRelease({ ...body, tag_name: "v0.2.0-rc.1" })).toBeNull();
  });

  it("refuses a tag that is not a release version", () => {
    for (const tag of ["latest", "0.2.0", "v0.2", "v0.2.0-3-g1a2b3c4", "v0.2.0-dirty", "v1.0.0; rm -rf /", "", 7]) {
      expect(parseLatestRelease({ ...body, tag_name: tag }), String(tag)).toBeNull();
    }
  });

  it("links only to the project's releases: another address is replaced by the tag's page", () => {
    expect(parseLatestRelease({ ...body, html_url: "https://evil.example/releases/tag/v0.2.0" })?.url).toBe("https://github.com/0x2u/keelson/releases/tag/v0.2.0");
    expect(parseLatestRelease({ ...body, html_url: undefined })?.url).toBe("https://github.com/0x2u/keelson/releases/tag/v0.2.0");
  });

  it("copes with missing or odd optional fields", () => {
    expect(parseLatestRelease({ tag_name: "v1.0.0" })).toMatchObject({ publishedAt: null, notes: "" });
    expect(parseLatestRelease({ tag_name: "v1.0.0", published_at: "yesterday", body: 5 })).toMatchObject({ publishedAt: null, notes: "" });
    expect(parseLatestRelease({ tag_name: "v1.0.0", body: "x".repeat(NOTES_MAX + 50) })?.notes).toHaveLength(NOTES_MAX);
  });

  it("is null for anything that is not that JSON", () => {
    for (const garbage of [null, undefined, "v0.2.0", 3, [], {}, { tag_name: null }, { message: "Not Found" }]) expect(parseLatestRelease(garbage)).toBeNull();
  });
});

describe("how the running dashboard stands against the latest release", () => {
  const cases: [string, string | null, ReleaseStatus][] = [
    // a release behind: offered
    ["v0.1.0", "v0.2.0", "newer"],
    ["v0.1.9", "v0.2.0", "newer"],
    ["v0.9.0", "v1.0.0", "newer"],
    ["v0.2.0-rc.1", "v0.2.0", "newer"],
    ["0.1.0", "v0.1.1", "newer"],
    // the same, or ahead
    ["v0.2.0", "v0.2.0", "current"],
    ["v0.3.0", "v0.2.0", "ahead"],
    ["v0.3.0-rc.1", "v0.2.0", "ahead"],
    // a build from source is never nagged, even with a release above it
    ["v0.1.0-4-g1a2b3c4", "v0.2.0", "ahead"],
    ["v0.1.0-4-g1a2b3c4", "v0.1.0", "ahead"],
    ["v0.1.0-dirty", "v0.2.0", "ahead"],
    ["v0.2.0-dirty", "v0.2.0", "ahead"],
    ["v0.2.0-rc.1-4-g1a2b3c4", "v0.2.0", "ahead"],
    // nothing to compare
    ["dev", "v0.2.0", "unknown"],
    ["dev-1a2b3c4", "v0.2.0", "unknown"],
    ["", "v0.2.0", "unknown"],
    ["1a2b3c4", "v0.2.0", "unknown"],
    ["v0.1.0", null, "unknown"],
  ];
  it.each(cases)("%s against %s is %s", (running, latest, status) => {
    expect(releaseStatus(running, latest === null ? null : release(latest))).toBe(status);
  });
});

describe("the update command", () => {
  it("is the one command of every install, with the tag twice", () => {
    expect(updateCommand("v0.2.0")).toBe("curl -fsSL https://github.com/0x2u/keelson/releases/download/v0.2.0/install.sh | sudo sh -s -- --version v0.2.0");
  });

  it("refuses text that is not a version, so a tag can never carry a shell command", () => {
    expect(() => updateCommand("v1.0.0; reboot")).toThrow();
    expect(() => updateCommand("latest")).toThrow();
  });
});
