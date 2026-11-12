import { describe, expect, it } from "vitest";
import { stripAnsi } from "@/lib/ansi-core";

const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  it("removes colour and style sequences, keeping the text between them", () => {
    expect(stripAnsi(`${ESC}[1;31merror${ESC}[0m: build failed ${ESC}[90m(12s)${ESC}[39m`)).toBe("error: build failed (12s)");
  });

  it("removes the cursor moves and line erases a progress bar writes", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1GProgress: resolved 120${ESC}[?25l`)).toBe("Progress: resolved 120");
  });

  it("removes OSC sequences (a hyperlink, a window title) whichever way they end", () => {
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ and ${ESC}]0;title\u0007done`)).toBe("link and done");
  });

  it("leaves a literal bracket sequence that has no ESC byte, and plain text, alone", () => {
    expect(stripAnsi("[0m is how an unescaped colour reset looks; a[1] too")).toBe("[0m is how an unescaped colour reset looks; a[1] too");
  });
});
