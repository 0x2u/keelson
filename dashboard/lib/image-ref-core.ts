/** An image reference split for display: the repository, and what picks the version (a tag, a digest, or both). */
export interface ImageRefParts {
  repository: string;
  tag?: string;
  /** The first 12 hex characters of the digest. */
  digest?: string;
}

const DIGEST = "@sha256:";

/**
 * Splits "ghcr.io/me/web:v1.4.2", "web@sha256:..." or "localhost:5000/web" into repository and version. A colon
 * followed by a slash is a registry port, not a tag.
 */
export function splitRef(ref: string): ImageRefParts {
  let rest = ref;
  let digest: string | undefined;
  const at = rest.indexOf(DIGEST);
  if (at >= 0) {
    digest = rest.slice(at + DIGEST.length, at + DIGEST.length + 12);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    const raw = rest.slice(colon + 1);
    // A tag that is a full commit hash is unreadable and says no more than its start.
    const tag = /^[0-9a-f]{40}$/.test(raw) ? raw.slice(0, 12) : raw;
    return { repository: rest.slice(0, colon), ...(tag !== "" ? { tag } : {}), ...(digest ? { digest } : {}) };
  }
  return { repository: rest, ...(digest ? { digest } : {}) };
}

/** The part that tells two versions of one repository apart: the tag, else the short digest, else "latest" (what Docker pulls). */
export function versionOf(ref: string): string {
  const { tag, digest } = splitRef(ref);
  return tag ?? digest ?? "latest";
}

/**
 * Shortens a repository in the middle so that its start (the registry or owner) and its end (the image name) both
 * stay readable: "ghcr.io/acme/…/web".
 */
export function middleTruncate(text: string, max = 32): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const tail = Math.ceil(keep * 0.55);
  const head = keep - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * What to type in the deploy field to run a reference again: its tag, else its full digest ("sha256:..."), else "" (a
 * reference with neither runs whatever `latest` is: there is nothing exact to deploy).
 */
export function deployInput(ref: string): string {
  const { tag } = splitRef(ref);
  if (tag !== undefined) return tag;
  return /@(sha256:[a-f0-9]{64})/.exec(ref)?.[1] ?? "";
}

/** The repository without its registry host: "ghcr.io/acme/shop" → "acme/shop"; "localhost:5000/shop" → "shop". */
export function repositoryName(repository: string): string {
  const parts = repository.split("/");
  // The first part is a registry host when it looks like one (a dot, a port, or localhost).
  return parts.length > 1 && /[.:]|^localhost$/.test(parts[0]) ? parts.slice(1).join("/") : repository;
}

/** What identifies a version in an image reference, for sentences and attention items. */
export interface ImageVersion {
  repository: string;
  /** "v1.4.2", "sha256:9f2c4e1ab07d", or "latest" when the reference names neither (Docker's default). */
  version: string;
}

/** "ghcr.io/acme/shop:v1.4.2" → { repository: "acme/shop", version: "v1.4.2" }. */
export function imageVersion(ref: string): ImageVersion {
  const { repository, tag, digest } = splitRef(ref);
  return { repository: repositoryName(repository), version: tag ?? (digest ? `sha256:${digest}` : "latest") };
}
