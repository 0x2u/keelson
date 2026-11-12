import { CircleAlertIcon, TriangleAlertIcon, InfoIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/**
 * What to show when a list is empty: the title says what is missing ("No jobs yet"), the text says what it is for or how
 * to get one, and `action` is the one next step. `bordered` is for an empty state that stands on the page by itself
 * (inside a card, leave it off); `compact` is for a small section among others.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  bordered,
  compact,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  bordered?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-3 px-6 text-center",
        compact ? "py-6" : "py-12",
        bordered && "rounded-xl border border-dashed",
      )}
    >
      {Icon && (
        <div className="relative flex size-11 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground shadow-[0_0_0_6px_color-mix(in_srgb,var(--brand)_5%,transparent)]">
          <Icon className="size-5" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children && <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>}
      </div>
      {action}
    </div>
  );
}

const NOTICE = {
  danger: { icon: CircleAlertIcon, variant: "destructive" as const },
  warning: { icon: TriangleAlertIcon, variant: "warning" as const },
  info: { icon: InfoIcon, variant: "info" as const },
};

/** A message about something that went wrong or needs attention: name the cause, then what to try. */
export function Notice({
  tone = "danger",
  title,
  children,
  action,
}: {
  tone?: keyof typeof NOTICE;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const { icon: Icon, variant } = NOTICE[tone];
  return (
    <Alert variant={variant}>
      <Icon />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>
        <div className="flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]">
          <div>{children}</div>
          {action}
        </div>
      </AlertDescription>
    </Alert>
  );
}
