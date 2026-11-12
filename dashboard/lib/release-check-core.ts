import { agentUpdate, parseVersion, releaseNotesUrl } from "@/lib/agent-binaries-core";

/** A release as GitHub's `releases/latest` describes it. */
export interface Release {
  /** `v0.2.0`: always a published, final release tag. */
  tag: string;
  /** The release notes page. */
  url: string;
  publishedAt: string | null;
  /** The release's text, trimmed and cut at `NOTES_MAX` characters. */
  notes: string;
}

/**
 * How the running dashboard stands against the latest release.
 * - `newer`: a newer release exists: offer the update.
 * - `current`: this is the latest release.
 * - `ahead`: a build between tags, a dirty one, or one newer than the latest release (a candidate): never offered an update.
 * - `unknown`: no release is known, or the running version is not a version (`dev`).
 */
export type ReleaseStatus = "newer" | "current" | "ahead" | "unknown";

/** Everything the pages need to say about the check: whether it runs, what it found, and whether the last attempt failed. */
export interface ReleaseCheck {
  enabled: boolean;
  status: ReleaseStatus;
  latest: Release | null;
  /** The last attempt to ask GitHub failed (the `latest` shown, if any, is from an earlier one). */
  failed: boolean;
  /** When GitHub was last asked, in ms since the epoch; null when it never was. */
  checkedAt: number | null;
}

export const NOTES_MAX = 4000;

/** A successful answer is kept for a day; a failed attempt is not repeated for an hour; "Check now" is allowed once a minute. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FAILURE_PAUSE_MS = 60 * 60 * 1000;
export const MANUAL_PAUSE_MS = 60 * 1000;

const RELEASE_PAGE = "https://github.com/0x2u/keelson/releases/";

/**
 * The latest release in the body GitHub answers `releases/latest` with, or null when it is not a release to offer: a draft, a
 * pre-release (flagged, or named like one), a tag that is not `vMAJOR.MINOR.PATCH`, or anything that is not that JSON.
 */
export function parseLatestRelease(body: unknown): Release | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.tag_name !== "string" || o.prerelease === true || o.draft === true) return null;
  const tag = o.tag_name.trim();
  const v = parseVersion(tag);
  if (!v || !tag.startsWith("v") || v.prerelease.length > 0 || v.commits > 0 || v.dirty) return null;
  // The link is shown to the operator: only a page of the project's releases, otherwise the one the tag makes.
  const url = typeof o.html_url === "string" && o.html_url.startsWith(RELEASE_PAGE) ? o.html_url : releaseNotesUrl(tag);
  if (url === null) return null;
  return {
    tag,
    url,
    publishedAt: typeof o.published_at === "string" && Number.isFinite(Date.parse(o.published_at)) ? o.published_at : null,
    notes: typeof o.body === "string" ? o.body.trim().slice(0, NOTES_MAX) : "",
  };
}

/**
 * Whether `latest` is something to update to from `running` (the dashboard's own version). A build between tags or a dirty one
 * is never compared: it was made from source, and nagging it would be wrong whatever tag exists.
 */
export function releaseStatus(running: string, latest: Release | null): ReleaseStatus {
  if (!latest) return "unknown";
  const v = parseVersion(running);
  if (!v) return "unknown";
  if (v.dirty || v.commits > 0) return "ahead";
  switch (agentUpdate(running, latest.tag)) {
    case "older":
      return "newer";
    case "current":
      return "current";
    case "newer":
      return "ahead";
    default:
      return "unknown";
  }
}

/** The one command that updates a dashboard install to a release: it keeps the data, the master key, the settings and the domain. */
export function updateCommand(tag: string): string {
  if (!parseVersion(tag)) throw new Error(`not a release tag: ${tag}`);
  return `curl -fsSL https://github.com/0x2u/keelson/releases/download/${tag}/install.sh | sudo sh -s -- --version ${tag}`;
}

/** The order in which to update, as the three steps the About card lists. */
export const UPDATE_STEPS = ["Back up the dashboard (Settings, Backup)", "Update the dashboard with the command", "Update the agent of each server from its Update page"] as const;
