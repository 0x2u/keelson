// The sub-navigation of Settings: the dashboard's own pages. Pure, so the active tab and the links are tested without a render.

export type SettingsTabId = "overview" | "security" | "api-tokens" | "integrations" | "notifications" | "backup";

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  href: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "overview", label: "Overview", href: "/settings" },
  { id: "security", label: "Security", href: "/settings/security" },
  { id: "api-tokens", label: "API tokens", href: "/settings/api-tokens" },
  { id: "integrations", label: "Integrations", href: "/settings/integrations" },
  { id: "notifications", label: "Notifications", href: "/settings/notifications" },
  { id: "backup", label: "Backup", href: "/settings/backup" },
];

/** The tab a path belongs to (its sub-pages count), or null outside Settings. */
export function activeSettingsTab(pathname: string): SettingsTabId | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/settings") return "overview";
  for (const tab of SETTINGS_TABS) {
    if (tab.id !== "overview" && (path === tab.href || path.startsWith(`${tab.href}/`))) return tab.id;
  }
  return null;
}
