import { expect, test } from "vitest";
import { redact } from "../src/redact.ts";
import { TOKEN } from "./fake.ts";

test("removes the configured token, token-shaped strings and bearer credentials", () => {
  const out = redact(`a ${TOKEN} b kst_zzzzzzzzzzzzzzzzzzzzzzzz c Authorization: Bearer abc.def-ghi d`, TOKEN);
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain("zzzzzzzz");
  expect(out).not.toContain("abc.def-ghi");
  expect(out).toBe("a [redacted] b [redacted] c Authorization: Bearer [redacted] d");
});

test("leaves ordinary text alone", () => {
  expect(redact("deploy of shop failed", TOKEN)).toBe("deploy of shop failed");
});
