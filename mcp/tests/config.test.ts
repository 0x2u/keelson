import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { TOKEN } from "./fake.ts";

const env = (over: Record<string, string | undefined> = {}) => ({ KEELSON_URL: "https://keelson.example.com", KEELSON_TOKEN: TOKEN, ...over });

describe("loadConfig", () => {
  test("accepts https and trims a trailing slash", () => {
    expect(loadConfig(env({ KEELSON_URL: "https://keelson.example.com/" }))).toEqual({
      baseUrl: "https://keelson.example.com",
      token: TOKEN,
      timeoutMs: 15_000,
    });
  });

  test("keeps a path prefix", () => {
    expect(loadConfig(env({ KEELSON_URL: "https://example.com/keelson/" })).baseUrl).toBe("https://example.com/keelson");
  });

  test.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://app.localhost"])("accepts plain http for %s", (url) => {
    expect(loadConfig(env({ KEELSON_URL: url })).baseUrl).toMatch(/^http:\/\//);
  });

  test.each(["http://keelson.example.com", "http://10.0.0.5:3000", "http://localhost.evil.com"])("rejects plain http for %s", (url) => {
    expect(() => loadConfig(env({ KEELSON_URL: url }))).toThrow(/https/);
  });

  test.each([
    [undefined, /KEELSON_URL is not set/],
    ["not a url", /not a valid URL/],
    ["ftp://example.com", /https/],
    ["https://user:pw@example.com", /credentials/],
    ["https://example.com/?a=1", /query/],
  ])("rejects KEELSON_URL %s", (url, message) => {
    expect(() => loadConfig(env({ KEELSON_URL: url }))).toThrow(message);
  });

  test("requires a well-formed token and never echoes it", () => {
    expect(() => loadConfig(env({ KEELSON_TOKEN: undefined }))).toThrow(/KEELSON_TOKEN is not set/);
    const bad = "kst_secret-but-too-short";
    try {
      loadConfig(env({ KEELSON_TOKEN: bad }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(bad);
      expect((err as Error).message).toMatch(/kst_/);
    }
  });
});
