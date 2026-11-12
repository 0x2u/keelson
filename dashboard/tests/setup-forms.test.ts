import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setupErrors } from "@/lib/setup-core";

const dir = mkdtempSync(path.join(tmpdir(), "keelson-setup-forms-"));
process.env.KEELSON_DASHBOARD_DATA_DIR = dir;

vi.mock("@/lib/session", () => ({ requireSession: async () => {}, currentSession: async () => null, createSession: async () => "s", clientInfo: async () => ({ ip: "127.0.0.1" }) }));
vi.mock("next/navigation", () => ({ redirect: () => {}, useRouter: () => ({ refresh: () => {} }) }));

const { SetupForm } = await import("@/components/setup/SetupForm");
const { RecoveryForm } = await import("@/components/setup/RecoveryForm");
const { SetupSteps } = await import("@/components/setup/SetupSteps");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the setup form", () => {
  const html = renderToStaticMarkup(createElement(SetupForm));

  it("labels every field, ties help to its field, and turns off the browser's validation bubbles", () => {
    expect(html).toContain("noValidate");
    expect(html).toMatch(/<label[^>]*for="token"[^>]*>Setup token/);
    expect(html).toMatch(/<label[^>]*for="password"[^>]*>Admin password/);
    expect(html).toMatch(/<label[^>]*for="confirm"[^>]*>Repeat the password/);
    expect(html).toMatch(/<input[^>]*id="token"[^>]*aria-describedby="token-help"/);
    expect(html).toMatch(/<input[^>]*id="password"[^>]*aria-describedby="password-help"/);
    expect(html).not.toMatch(/<input[^>]*\srequired/);
  });

  it("states the password rule and where the token is", () => {
    expect(html).toContain("At least 12 characters");
    expect(html).toContain("Keelson setup token");
  });

  it("keeps the passwords out of the page and never prefilled", () => {
    expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value="[^"]/);
  });
});

describe("the form's rules are the action's", () => {
  it("lists each problem once", () => {
    expect(setupErrors({ token: "t", password: "twelve chars", confirm: "twelve chars" })).toEqual({});
    expect(setupErrors({ token: " ", password: "", confirm: "x" })).toEqual({
      token: "Enter the setup token from the container log",
      password: "Use at least 12 characters",
      confirm: "The two passwords differ",
    });
  });
});

describe("the recovery form", () => {
  it("offers the download first and keeps the confirmation locked until the file was fetched", () => {
    const html = renderToStaticMarkup(createElement(RecoveryForm, { fromFile: true, downloaded: false }));
    expect(html).toContain("Download keelson-recovery.txt");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*\sdisabled=""/);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Continue/);
    expect(html).toContain("I saved it");
  });

  it("unlocks the confirmation after a download, and offers the file again", () => {
    const html = renderToStaticMarkup(createElement(RecoveryForm, { fromFile: true, downloaded: true }));
    expect(html).toContain("Download it again");
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*\sdisabled=""/);
  });

  it("has no download when the key comes from the environment", () => {
    const html = renderToStaticMarkup(createElement(RecoveryForm, { fromFile: false, downloaded: false }));
    expect(html).not.toContain("keelson-recovery.txt");
    expect(html).toContain("I know where my master key is kept");
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*\sdisabled=""/);
  });
});

describe("the step indicator", () => {
  it("marks the current step and the finished ones", () => {
    const html = renderToStaticMarkup(createElement(SetupSteps, { current: 2 }));
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*>.*Recovery file/);
    expect(html).toContain("(done)");
  });
});
