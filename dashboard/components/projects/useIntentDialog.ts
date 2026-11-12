"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The open state of a dialog that a link can open (`?add=app`): it starts open when the page was reached through such a link,
 * and closing it takes the parameter off the address, so a reload or the back button does not open it again. The page keys
 * the component by the intent, so a second link followed while it is mounted opens it anew.
 */
export function useIntentDialog(intent: boolean): [boolean, (open: boolean) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(intent);
  return [
    open,
    (next) => {
      setOpen(next);
      if (!next && intent) router.replace(pathname, { scroll: false });
    },
  ];
}
