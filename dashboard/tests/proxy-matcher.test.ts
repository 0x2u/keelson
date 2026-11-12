import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

// Which paths never reach the gate (no session check, no allowlist, no headers): only files that hold nothing. A looser
// pattern here would open a path to everyone, so the exact set is pinned.

const gate = new RegExp(`^${config.matcher[0]}$`);

describe("the paths the proxy does not see", () => {
  it("are the static assets, the icons and the health endpoint", () => {
    for (const p of ["/icon.svg", "/apple-icon.png", "/favicon.ico", "/_next/static/chunks/a.js", "/_next/image", "/api/health"]) expect(gate.test(p), p).toBe(false);
  });

  it("are nothing else: a look-alike or a deeper path with the same name goes through the gate", () => {
    for (const p of ["/", "/login", "/icon.svgx", "/icon.svg/x", "/apple-icon.png.html", "/favicon.icox", "/servers/icon.svg", "/projects/apple-icon.png", "/x/favicon.ico", "/api/v1/servers", "/_next/data/x"]) {
      expect(gate.test(p), p).toBe(true);
    }
  });
});
