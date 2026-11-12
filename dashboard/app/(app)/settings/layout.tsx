import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/settings/SettingsTabs";

/** Settings: one sub-navigation over the dashboard's own pages. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsTabs />
      {children}
    </>
  );
}
