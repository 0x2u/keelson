import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { deriveKey, passwordFingerprint } from "@/lib/env";
import { isValidSessionToken, sessionIdFromToken, signToken, verifyToken } from "@/lib/session-token";

async function token(claims: Record<string, unknown>, opts: { sub?: string; exp?: string; key?: Uint8Array } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub ?? "operator")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? deriveKey("session"));
}

const valid = () => ({ typ: "session", sid: "abc", pwv: passwordFingerprint() });

describe("session tokens", () => {
  it("accepts a session token for the operator with the current password fingerprint", async () => {
    const t = await signToken("session", { sid: "s1" }, 60);
    expect(await isValidSessionToken(t)).toBe(true);
    expect(await sessionIdFromToken(t)).toBe("s1");
  });

  it("rejects a missing token", async () => {
    expect(await isValidSessionToken(undefined)).toBe(false);
    expect(await isValidSessionToken("")).toBe(false);
  });

  it("rejects a token issued before the password changed, or without a session id", async () => {
    expect(await isValidSessionToken(await token({ ...valid(), pwv: "0000000000000000" }))).toBe(false);
    expect(await isValidSessionToken(await token({ typ: "session", sid: "abc" }))).toBe(false);
    expect(await isValidSessionToken(await token({ typ: "session", pwv: passwordFingerprint() }))).toBe(false);
  });

  it("rejects another subject, an expired token, and a foreign signature", async () => {
    expect(await isValidSessionToken(await token(valid(), { sub: "someone" }))).toBe(false);
    expect(await isValidSessionToken(await token(valid(), { exp: "-10s" }))).toBe(false);
    expect(await isValidSessionToken(await token(valid(), { key: new Uint8Array(32).fill(7) }))).toBe(false);
  });

  it("rejects a tampered token and unsigned tokens", async () => {
    const good = await token(valid());
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...valid(), sub: "operator", exp: 9999999999 })).toString("base64url");
    expect(await isValidSessionToken(`${h}.${forged}.${s}`)).toBe(false);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    expect(await isValidSessionToken(none)).toBe(false);
  });

  it("never lets a token made for one purpose pass as another", async () => {
    const pending = await signToken("pending", {}, 60);
    const challenge = await signToken("webauthn", { sid: "abc", challenge: "x" }, 60);
    expect(await isValidSessionToken(pending)).toBe(false);
    expect(await isValidSessionToken(challenge)).toBe(false);
    expect(await verifyToken("pending", pending)).not.toBeNull();
    expect(await verifyToken("webauthn", pending)).toBeNull();
    expect(await verifyToken("pending", await signToken("session", { sid: "abc" }, 60))).toBeNull();
  });

  it("keeps the session key independent of the encryption key", () => {
    expect(deriveKey("session").equals(deriveKey("encryption"))).toBe(false);
  });
});
