import { describe, expect, it } from "vitest";
import { parseUserAgent } from "@/lib/user-agent";

describe("parseUserAgent", () => {
  it("recognises desktop Chrome", () => {
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")).toBe("Chrome on Linux");
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")).toBe("Chrome on Windows");
  });

  it("tells Edge from Chrome", () => {
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67")).toBe("Edge on Windows");
  });

  it("recognises Firefox", () => {
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0")).toBe("Firefox on macOS");
  });

  it("recognises Safari on macOS and iOS", () => {
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")).toBe("Safari on macOS");
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  });

  it("prefers Android over Linux", () => {
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")).toBe("Chrome on Android");
  });

  it("falls back when nothing is recognised", () => {
    expect(parseUserAgent("curl/8.5.0")).toBe("Unknown browser");
    expect(parseUserAgent("")).toBe("Unknown browser");
    expect(parseUserAgent(null)).toBe("Unknown browser");
  });
});
