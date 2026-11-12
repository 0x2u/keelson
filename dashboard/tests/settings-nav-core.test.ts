import { describe, expect, it } from "vitest";
import { SETTINGS_TABS, activeSettingsTab } from "@/lib/settings-nav-core";

describe("the settings sub-navigation", () => {
  it("lists the index and the five pages, each at its own address", () => {
    expect(SETTINGS_TABS.map((t) => t.href)).toEqual(["/settings", "/settings/security", "/settings/api-tokens", "/settings/integrations", "/settings/notifications", "/settings/backup"]);
    expect(new Set(SETTINGS_TABS.map((t) => t.id)).size).toBe(SETTINGS_TABS.length);
  });

  it("marks the tab of every settings path, the index included", () => {
    expect(activeSettingsTab("/settings")).toBe("overview");
    expect(activeSettingsTab("/settings/")).toBe("overview");
    for (const tab of SETTINGS_TABS.slice(1)) {
      expect(activeSettingsTab(tab.href)).toBe(tab.id);
      expect(activeSettingsTab(`${tab.href}/more`)).toBe(tab.id);
    }
  });

  it("marks nothing outside Settings", () => {
    expect(activeSettingsTab("/servers/s1/settings")).toBeNull();
    expect(activeSettingsTab("/settingsx")).toBeNull();
    expect(activeSettingsTab("/settings/unknown")).toBeNull();
  });
});
