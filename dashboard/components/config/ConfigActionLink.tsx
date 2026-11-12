import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { GatedButton } from "@/components/GatedButton";
import { Button } from "@/components/ui/button";

/** A button that links to a configuration screen; on a read-only server it is disabled and says so. */
export function ConfigActionLink({
  href,
  enabled,
  variant = "outline",
  size,
  children,
  "aria-label": ariaLabel,
}: {
  href: string;
  enabled: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  children: ReactNode;
  "aria-label"?: string;
}) {
  if (enabled) {
    return (
      <Button asChild variant={variant} size={size}>
        <Link href={href} aria-label={ariaLabel}>
          {children}
        </Link>
      </Button>
    );
  }
  return (
    <GatedButton canDeploy={false} variant={variant} size={size} aria-label={ariaLabel}>
      {children}
    </GatedButton>
  );
}
