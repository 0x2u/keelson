import "server-only";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { addPasskey, getPasskey, listPasskeys, touchPasskey } from "@/lib/auth/store";
import { publicUrl, secureCookies } from "@/lib/env";
import { signToken, verifyToken } from "@/lib/session-token";

const CHALLENGE_COOKIE = "keelson_challenge";
const CHALLENGE_SECONDS = 5 * 60;
const USER_ID = new TextEncoder().encode("keelson-operator");

type Flow = "register" | "login";

/** Passkeys are bound to the dashboard's host name: they need KEELSON_PUBLIC_URL. */
export function passkeysAvailable(): boolean {
  const url = publicUrl();
  // Browsers only run WebAuthn on https, or on localhost for development.
  return url !== null && (url.protocol === "https:" || url.hostname === "localhost");
}

function relyingParty(): { rpID: string; origin: string } {
  const url = publicUrl();
  if (!url || !passkeysAvailable()) throw new Error("passkeys need KEELSON_PUBLIC_URL set to the dashboard's https address");
  return { rpID: url.hostname, origin: url.origin };
}

/** The challenge travels in a short-lived signed cookie, so the server keeps no state between the two steps. */
async function rememberChallenge(flow: Flow, challenge: string): Promise<void> {
  (await cookies()).set(CHALLENGE_COOKIE, await signToken("webauthn", { flow, challenge }, CHALLENGE_SECONDS), {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies(),
    path: "/",
    maxAge: CHALLENGE_SECONDS,
  });
}

/** The pending challenge for this flow, consumed: it can be answered once. */
async function takeChallenge(flow: Flow): Promise<string | null> {
  const jar = await cookies();
  const payload = await verifyToken("webauthn", jar.get(CHALLENGE_COOKIE)?.value);
  jar.delete(CHALLENGE_COOKIE);
  if (!payload || payload.flow !== flow || typeof payload.challenge !== "string") return null;
  return payload.challenge;
}

export async function registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: "Keelson",
    rpID,
    userName: "operator",
    userID: USER_ID,
    attestationType: "none",
    excludeCredentials: listPasskeys().map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await rememberChallenge("register", options.challenge);
  return options;
}

/** Verifies the browser's answer and stores the passkey. False when it does not check out. */
export async function finishRegistration(response: RegistrationResponseJSON, name: string): Promise<boolean> {
  const expectedChallenge = await takeChallenge("register");
  if (!expectedChallenge) return false;
  const { rpID, origin } = relyingParty();
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified) return false;
    const { credential } = result.registrationInfo;
    addPasskey({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: name.trim().slice(0, 60) || "Passkey",
    });
    return true;
  } catch {
    return false;
  }
}

/** Options for a sign-in that names no account: the browser offers the passkeys it holds for this site. */
export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  await rememberChallenge("login", options.challenge);
  return options;
}

/** True when the response proves possession of a registered passkey, with the user verified. */
export async function finishAuthentication(response: AuthenticationResponseJSON): Promise<boolean> {
  const expectedChallenge = await takeChallenge("login");
  if (!expectedChallenge) return false;
  const stored = getPasskey(response.id);
  if (!stored) return false;
  const { rpID, origin } = relyingParty();
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: stored.id, publicKey: stored.publicKey, counter: stored.counter, transports: stored.transports },
    });
    if (!result.verified) return false;
    touchPasskey(stored.id, result.authenticationInfo.newCounter);
    return true;
  } catch {
    return false;
  }
}
