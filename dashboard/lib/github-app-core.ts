/**
 * Pure rules of the GitHub App: the private key's checks and the app JWT GitHub wants (RS256). No database, no network.
 */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/** What the installation token is limited to: the least the builds need, nothing else. */
export const INSTALLATION_PERMISSIONS = { contents: "read", statuses: "write", pull_requests: "read", metadata: "read" } as const;

/** What a token that also lists the workflow runs of a repository asks for: the same, plus Actions: read. */
export const RUNS_PERMISSIONS = { ...INSTALLATION_PERMISSIONS, actions: "read" } as const;

/** The JWT is valid for 9 minutes (GitHub's limit is 10) and starts a minute in the past to absorb clock drift. */
export const APP_JWT_BACKDATE_SECONDS = 60;
export const APP_JWT_LIFETIME_SECONDS = 9 * 60;

const APP_ID = /^[0-9]{1,20}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export function isAppId(text: string): boolean {
  return APP_ID.test(text);
}

export function isAppSlug(text: string): boolean {
  return SLUG.test(text);
}

/** The private key as a key object; throws an Error whose message says what is wrong, and never contains the key. */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("That is not a private key in PEM format. Paste the whole .pem file GitHub gave you, including the BEGIN and END lines.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("The private key is not an RSA key: GitHub App keys are RSA.");
  return key;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** The signed JWT that identifies the App to GitHub (`iss` is its ID), for `nowSeconds` (the Unix time). */
export function signAppJwt(appId: string, privateKey: string | KeyObject, nowSeconds: number): string {
  const key = typeof privateKey === "string" ? parsePrivateKey(privateKey) : privateKey;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - APP_JWT_BACKDATE_SECONDS, exp: nowSeconds + APP_JWT_LIFETIME_SECONDS, iss: appId }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The address of a repository's source at a commit, as the agent downloads it. Null for anything that is not owner/name and a full SHA. */
export function tarballUrl(repo: string, sha: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) return null;
  return `https://api.github.com/repos/${repo}/tarball/${sha}`;
}
