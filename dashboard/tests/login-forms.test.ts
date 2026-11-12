import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-login-forms-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, useRouter: () => ({ refresh: () => {} }) }));

const { LoginForm } = await import("@/components/LoginForm");
const { SecondFactorForm } = await import("@/components/SecondFactorForm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the sign-in forms", () => {
  it("labels the password field and turns off the browser's validation bubbles", () => {
    const html = renderToStaticMarkup(createElement(LoginForm, { showPasskey: false }));
    expect(html).toContain("noValidate");
    expect(html).toMatch(/<label[^>]*for="password"[^>]*>Password/);
    expect(html).toMatch(/<input[^>]*id="password"/);
    expect(html).not.toMatch(/<input[^>]*\srequired/);
  });

  it("ties the verification code to its hint and turns off native validation", () => {
    const html = renderToStaticMarkup(createElement(SecondFactorForm, { showPasskey: false }));
    expect(html).toContain("noValidate");
    expect(html).toMatch(/<label[^>]*for="code"[^>]*>Verification code/);
    expect(html).toMatch(/aria-describedby="code-help"/);
    expect(html).toContain('id="code-help"');
    expect(html).not.toMatch(/<input[^>]*\srequired/);
  });
});
