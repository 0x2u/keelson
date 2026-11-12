import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

describe("encryption at rest", () => {
  it("round-trips any text, including non-ASCII", () => {
    for (const text of ["", "token", "pässwörd 🔑", "line1\nline2".repeat(500)]) {
      expect(decrypt(encrypt(text))).toBe(text);
    }
  });

  it("does not reveal the plaintext and uses a fresh IV each time", () => {
    const a = encrypt("super-secret-token");
    expect(a).not.toContain("super-secret-token");
    expect(Buffer.from(a.slice(3), "base64").toString("latin1")).not.toContain("super-secret-token");
    expect(encrypt("super-secret-token")).not.toBe(a);
  });

  it("detects tampering anywhere in the value", () => {
    const stored = encrypt("secret");
    const raw = Buffer.from(stored.slice(3), "base64");
    for (const index of [0, 12, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] ^= 0x01;
      expect(() => decrypt(`v1:${copy.toString("base64")}`), `byte ${index}`).toThrow();
    }
  });

  it("rejects unknown or truncated formats", () => {
    expect(() => decrypt("v2:AAAA")).toThrow();
    expect(() => decrypt("v1:AAAA")).toThrow();
    expect(() => decrypt("plaintext")).toThrow();
  });
});
