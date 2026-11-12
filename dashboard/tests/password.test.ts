import { describe, expect, it } from "vitest";
import { hashPassword, PasswordBusyError, verifyPassword } from "@/lib/password";

describe("password hashing", () => {
  it("accepts the right password and rejects others", async () => {
    const hash = hashPassword("a long enough password");
    expect(await verifyPassword("a long enough password", hash)).toBe(true);
    expect(await verifyPassword("a long enough passwore", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashPassword("same password here")).not.toBe(hashPassword("same password here"));
  });

  it("never uses '$', which dotenv files expand", () => {
    expect(hashPassword("a long enough password")).not.toContain("$");
  });

  it("rejects malformed hashes instead of throwing", async () => {
    for (const bad of ["", "plain", "scrypt:::::", "bcrypt:1:2:3:a:b", "scrypt:abc:8:1:AAAA:AAAA", "scrypt:32768:8:1::"]) {
      expect(await verifyPassword("whatever", bad), bad).toBe(false);
    }
  });

  it("refuses hashes whose cost would exhaust memory", async () => {
    // N=2^20, r=32 would need 4 GiB: it must be treated as malformed, fast.
    const hostile = `scrypt:${2 ** 20}:32:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
    const started = Date.now();
    expect(await verifyPassword("whatever", hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // The check is asynchronous (a failed sign-in must not stall the event loop) and bounded: a flood is refused, not queued
  // without end. And the answer is a promise: a caller that forgets to await it would read "true" for every password.
  it("answers with a promise, runs a few checks at a time and refuses the rest", async () => {
    const hash = hashPassword("a long enough password");
    const pending = verifyPassword("wrong", hash);
    expect(pending).toBeInstanceOf(Promise);
    const burst = await Promise.allSettled(Array.from({ length: 40 }, () => verifyPassword("wrong", hash)));
    const refused = burst.filter((r) => r.status === "rejected" && r.reason instanceof PasswordBusyError);
    expect(refused.length).toBeGreaterThan(0);
    expect(burst.filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(0);
    await pending;
    expect(await verifyPassword("a long enough password", hash)).toBe(true); // and it recovers
  });
});
