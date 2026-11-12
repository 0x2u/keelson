import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateSecret, otpauthUrl, stepAt, totpCode, verifyTotp } from "@/lib/auth/totp";

// RFC 6238 appendix B: the SHA-1 secret is "12345678901234567890", 8 digits there; we use 6, the last 6 of each.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(RFC_SECRET, seconds * 1000), `at ${seconds}`).toBe(code);
    }
  });

  it("round-trips base32 and tolerates the spacing authenticator apps display", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode("jbsw y3dp-ehpk 3pxp")).toEqual(base32Decode("JBSWY3DPEHPK3PXP"));
    expect(() => base32Decode("not*base32")).toThrow();
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("accepts the previous, current and next step but nothing further", () => {
    const now = 1_700_000_000_000;
    const secret = generateSecret();
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(secret, totpCode(secret, now + offset * 30_000), now), `offset ${offset}`).toBe(stepAt(now) + offset);
    }
    expect(verifyTotp(secret, totpCode(secret, now + 2 * 30_000), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 2 * 30_000), now)).toBeNull();
  });

  it("refuses a code whose step was already used", () => {
    const now = 1_700_000_000_000;
    const secret = generateSecret();
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, now, step!)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    const secret = generateSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      expect(verifyTotp(secret, bad), JSON.stringify(bad)).toBeNull();
    }
    expect(verifyTotp(secret, ` ${totpCode(secret)} `.replace(/(\d{3})(\d{3})/, "$1 $2"))).not.toBeNull();
  });

  it("builds an otpauth URL an authenticator can import", () => {
    const url = new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "operator@keelson", "Keelson"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(url.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(url.searchParams.get("issuer")).toBe("Keelson");
    expect(decodeURIComponent(url.pathname)).toBe("/Keelson:operator@keelson");
  });
});
