import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/security" }));

const { SettingsTabs } = await import("@/components/settings/SettingsTabs");

describe("the settings sub-nav", () => {
  it("is a nav landmark linking every page and marking the current one", () => {
    const html = renderToStaticMarkup(createElement(SettingsTabs));
    expect(html).toContain("<nav");
    for (const href of ["/settings", "/settings/security", "/settings/api-tokens", "/settings/integrations", "/settings/notifications"]) expect(html).toContain(`href="${href}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/settings\/security"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/security"/);
  });

  it("marks the index on /settings", () => {
    const html = renderToStaticMarkup(createElement(SettingsTabs, { pathname: "/settings" }));
    expect(html).toMatch(/href="\/settings"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings"/);
  });
});
