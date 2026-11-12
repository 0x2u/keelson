// Signing and verification only, with no Next.js or server-only imports: the proxy uses it too.
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { deriveKey, passwordFingerprint } from "@/lib/env";

export const SESSION_COOKIE = "keelson_session";
/** Set after the password is accepted and a second factor is still owed. */
export const PENDING_COOKIE = "keelson_pending";
export const SESSION_SECONDS = 12 * 60 * 60;
export const PENDING_SECONDS = 5 * 60;

/**
 * What a signed token is for. The kind is inside the signature, so a token issued for one purpose
 * (half-way through a login, or holding a WebAuthn challenge) can never be replayed as another.
 */
export type TokenKind = "session" | "pending" | "webauthn";

export async function signToken(kind: TokenKind, claims: Record<string, unknown>, seconds: number): Promise<string> {
  return new SignJWT({ ...claims, typ: kind, pwv: passwordFingerprint() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("operator")
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(deriveKey("session"));
}

/**
 * The claims of a token of the given kind, or null. The password fingerprint inside means
 * changing the operator password invalidates every token issued before.
 */
export async function verifyToken(kind: TokenKind, token: string | undefined): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, deriveKey("session"), { algorithms: ["HS256"] });
    if (payload.sub !== "operator" || payload.typ !== kind || payload.pwv !== passwordFingerprint()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The session id inside a session cookie, or null. This checks the signature only: whether the
 * session was revoked or went idle is in the database, and is checked by every entry point.
 */
export async function sessionIdFromToken(token: string | undefined): Promise<string | null> {
  const payload = await verifyToken("session", token);
  return payload && typeof payload.sid === "string" ? payload.sid : null;
}

export async function isValidSessionToken(token: string | undefined): Promise<boolean> {
  return (await sessionIdFromToken(token)) !== null;
}
