import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secureCookies } from "@/lib/env";

const KEYS = ["KEELSON_PUBLIC_URL", "KEELSON_INSECURE_COOKIES"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("whether the session cookie is Secure (and HSTS is sent)", () => {
  it("is on by default", () => {
    expect(secureCookies()).toBe(true);
  });

  it("is off only for plain-http local use, when asked", () => {
    process.env.KEELSON_INSECURE_COOKIES = "true";
    expect(secureCookies()).toBe(false);
    process.env.KEELSON_PUBLIC_URL = "http://localhost:3000";
    expect(secureCookies()).toBe(false);
  });

  it("stays on behind an https address even when the compose default asks for insecure cookies", () => {
    // deploy/compose.yaml sets KEELSON_INSECURE_COOKIES for its loopback default and wins over dashboard.env: an https
    // KEELSON_PUBLIC_URL added there afterwards must not leave the session cookie without the Secure flag.
    process.env.KEELSON_INSECURE_COOKIES = "true";
    process.env.KEELSON_PUBLIC_URL = "https://keelson.example.com";
    expect(secureCookies()).toBe(true);
    process.env.KEELSON_PUBLIC_URL = "  HTTPS://keelson.example.com  ";
    expect(secureCookies()).toBe(true);
  });
});
