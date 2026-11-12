import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EYEBROW } from "@/components/signature";
import { cn } from "@/lib/utils";

/** The one focus ring of the dashboard; Button, links, tabs and pills all use it. */
export const FOCUS_RING = "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** A titled block of a page: the heading, an optional action next to it (a link, a button), then the content. */
export function PageSection({
  id,
  title,
  action,
  children,
  className,
}: {
  /** The heading's id; given, the section is labelled by it, otherwise by the title text. */
  id?: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} aria-label={id ? undefined : title} className={cn("space-y-3", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className={EYEBROW}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One term and its value, for a `<dl>`: a small muted label over the value. */
export function DefinitionItem({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** A `<dl>` laid out as a grid of definition items. */
export function DefinitionList({ className, ...props }: ComponentProps<"dl">) {
  return <dl className={cn("grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4", className)} {...props} />;
}

const PILL = cn(
  "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
  FOCUS_RING,
);
const PILL_ON = "bg-background text-foreground shadow-sm";

export interface SegmentedItem {
  key: string;
  label: ReactNode;
  href: string;
  current: boolean;
  className?: string;
}

/** A row of pills that navigate (an environment, an app): links with `aria-current`, named as a group. */
export function SegmentedNav({ label, items, className }: { label: string; items: SegmentedItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn("flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted p-[3px]", className)}>
      {items.map((item) => (
        <Link key={item.key} href={item.href} aria-current={item.current ? "page" : undefined} className={cn(PILL, item.className, item.current && PILL_ON)}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** The link style of running text and table cells: medium weight, underlined on hover. */
export const INLINE_LINK = cn("rounded-sm font-medium underline-offset-4 hover:underline", FOCUS_RING);

export function InlineLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn(INLINE_LINK, className)} {...props} />;
}

/** The inset of the first and last cell of every table in a `TableCard`. */
export const TABLE_INSET =
  "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4";

/**
 * The card of a table. One geometry everywhere: no outer padding, the table runs edge to edge and its first and last
 * cells are inset by the card's own padding, so a title row and the rows below line up. Without a title it is just the
 * table (a list that the page heading already names).
 */
export function TableCard({
  title,
  description,
  action,
  children,
  className,
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "title">) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", TABLE_INSET, className)} {...props}>
      {(title || action) && (
        <CardHeader className="border-b px-4 py-3">
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      {children}
    </Card>
  );
}

/** The card of a form or a settings panel: the default card padding, a title, what it is for, then the fields. */
export function FormCard({
  title,
  description,
  action,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
      {footer && <CardFooter className="flex-wrap gap-2">{footer}</CardFooter>}
    </Card>
  );
}
