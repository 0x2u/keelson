import { describe, expect, it } from "vitest";
import { sign } from "@/lib/sign";

describe("request signing", () => {
  it("matches the agent's Go implementation byte for byte", () => {
    // Computed by agent/internal/api.Sign (and cross-checked with openssl).
    expect(sign("0123456789abcdef0123456789abcdef", 1700000000, "POST", "/v1/apps/web/deploy", '{"tag":"abc"}')).toBe(
      "a380a28e4c67063d281a41635693308bfafa22a9223d8b254d414d749f159778",
    );
  });

  it("covers every component of the request", () => {
    const base = sign("k".repeat(32), 100, "POST", "/v1/a", "body");
    expect(sign("j".repeat(32), 100, "POST", "/v1/a", "body")).not.toBe(base);
    expect(sign("k".repeat(32), 101, "POST", "/v1/a", "body")).not.toBe(base);
    expect(sign("k".repeat(32), 100, "GET", "/v1/a", "body")).not.toBe(base);
    expect(sign("k".repeat(32), 100, "POST", "/v1/b", "body")).not.toBe(base);
    expect(sign("k".repeat(32), 100, "POST", "/v1/a", "Body")).not.toBe(base);
  });
});
