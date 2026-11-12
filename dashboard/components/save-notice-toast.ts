"use client";

import { toast } from "sonner";
import type { SaveNotice } from "@/lib/app-config-core";

/** A persistent notice has a close button and no timeout: a pending deploy must not vanish unseen. `push` opens its link in the app. */
export function showSaveNotice(notice: SaveNotice, push: (href: string) => void): void {
  toast.success(notice.title, {
    description: notice.description,
    duration: notice.persistent ? Number.POSITIVE_INFINITY : undefined,
    closeButton: notice.persistent,
    action: notice.action ? { label: notice.action.label, onClick: () => push(notice.action!.href) } : undefined,
  });
}
