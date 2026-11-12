import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TABLE_INSET } from "@/components/layout";
import { cn } from "@/lib/utils";

/**
 * The attributes of the outermost element of a loading state: a polite status with a label. Sub-skeletons are
 * decorative (`aria-hidden`), so a screen reader announces the label once and never a nested status.
 */
export function skeletonRoot(label: string) {
  return { role: "status", "aria-busy": true, "aria-label": label } as const;
}

/** The heading block of a page: breadcrumb-sized line, title, optional description and action button. */
export function PageHeaderSkeleton({ description = true, action = false }: { description?: boolean; action?: boolean }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        {description && <Skeleton className="h-4 w-80 max-w-full" />}
      </div>
      {action && <Skeleton className="h-9 w-32" />}
    </div>
  );
}

/**
 * Placeholder for a `TableCard`: the same geometry as the real one (card without gap or padding, an optional titled
 * header row, a table header row and rows of the real height, first and last cell inset). With a `label` it is the
 * page's status root; without, it sits inside another skeleton and is decorative.
 */
export function TableCardSkeleton({
  label,
  title = false,
  rows = 4,
  className,
}: {
  label?: string;
  title?: boolean;
  rows?: number;
  className?: string;
}) {
  return (
    <Card
      className={cn("gap-0 overflow-hidden py-0", TABLE_INSET, className)}
      {...(label ? skeletonRoot(label) : { "aria-hidden": true })}
    >
      {title && (
        <CardHeader className="border-b px-4 py-3">
          <Skeleton className="h-5 w-32" />
        </CardHeader>
      )}
      <div className="flex h-10 items-center border-b px-4">
        <Skeleton className="h-3 w-24" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-12 items-center border-b px-4 last:border-b-0">
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      ))}
    </Card>
  );
}

/** Placeholder for a card of the server's overview while the agent measures something. */
export function HealthSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <Card className="gap-4 py-4" aria-hidden>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** Placeholder for a form card: a title, a line of help, then `fields` label-and-input pairs. */
export function FormCardSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <Card aria-hidden>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-5">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** The whole loading state of a page with a PageHeader: the status root, breadcrumb line, heading, then `children`. */
export function PageSkeleton({
  label,
  breadcrumbs = true,
  description = true,
  action = false,
  children,
}: {
  label: string;
  breadcrumbs?: boolean;
  description?: boolean;
  action?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div {...skeletonRoot(label)}>
      {breadcrumbs && <Skeleton className="mb-3 h-4 w-56" aria-hidden />}
      <PageHeaderSkeleton description={description} action={action} />
      <div aria-hidden>{children}</div>
    </div>
  );
}
