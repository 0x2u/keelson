"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ICONS } from "@/lib/icons";
import { READ_ONLY_REASON } from "@/lib/gate-core";

export interface AddMenuItem {
  key: string;
  /** The server it would be added on. */
  server: string;
  href: string;
  /** False on a read-only server: the item is there, disabled, and says why. */
  enabled: boolean;
}

/**
 * "Add job" / "Add database" when it can be added on several servers: asks which one. Each item opens that server's
 * configuration form; a read-only server is listed, disabled, with its reason.
 */
export function AddTargetMenu({
  label,
  items,
  variant = "outline",
  size,
}: {
  label: string;
  items: AddMenuItem[];
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size}>
          <ICONS.add />
          {label}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>On which server?</DropdownMenuLabel>
        {items.map((item) =>
          item.enabled ? (
            <DropdownMenuItem key={item.key} asChild>
              <Link href={item.href}>{item.server}</Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={item.key} disabled>
              {item.server}
              <span className="ml-auto text-xs text-muted-foreground">{READ_ONLY_REASON}</span>
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
