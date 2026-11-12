import type { ComponentProps, ReactNode } from "react";
import { TableCard } from "@/components/layout";
import { cn } from "@/lib/utils";

// The table of a resource list (jobs, databases): one card geometry (`TableCard`), a head that stays under the top bar
// while the page scrolls, rows whose cells say which breakpoint they appear at, and below 640 px a stacked card per row
// (each cell labelled by its column) instead of columns that vanish. Server components: no state.

/** From which breakpoint a column shows as a table cell; under 640 px every cell is shown, stacked. */
export type ColumnFrom = "sm" | "md" | "lg";

const FROM: Record<ColumnFrom, string> = {
  sm: "hidden sm:table-cell max-sm:flex",
  md: "hidden md:table-cell max-sm:flex",
  lg: "hidden lg:table-cell max-sm:flex",
};

const HEAD_FROM: Record<ColumnFrom, string> = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" };

const STACKED_LABEL =
  "max-sm:before:text-xs max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)] max-sm:before:min-w-20 max-sm:before:shrink-0";

/**
 * The card and the table in it. `overflow-clip` rounds the card's corners without making it a scroll container, which
 * would stop the head from sticking to the viewport.
 */
export function ResourceTable({ className, children, ...props }: ComponentProps<"table">) {
  return (
    <TableCard className="overflow-clip">
      <table data-slot="resource-table" className={cn("w-full text-sm max-sm:block", className)} {...props}>
        {children}
      </table>
    </TableCard>
  );
}

/** The head row; hidden when the rows are stacked cards (each cell then carries its own label). */
export function ResourceHead({ children }: { children: ReactNode }) {
  return (
    <thead data-slot="resource-head" className="max-sm:hidden">
      <tr className="border-b">{children}</tr>
    </thead>
  );
}

export function ResourceHeadCell({ from, className, children }: { from?: ColumnFrom; className?: string; children: ReactNode }) {
  return (
    <th
      scope="col"
      className={cn("sticky top-14 z-10 h-10 bg-card px-2 text-left align-middle font-medium whitespace-nowrap", from && HEAD_FROM[from], className)}
    >
      {children}
    </th>
  );
}

export function ResourceBody({ children }: { children: ReactNode }) {
  return <tbody className="max-sm:block [&_tr:last-child]:border-0">{children}</tbody>;
}

/** One row. `state` marks a row that needs a look (`data-state` is also what tests and styles read). */
export function ResourceRow({ state, problem, className, ...props }: ComponentProps<"tr"> & { state?: string; problem?: boolean }) {
  return (
    <tr
      data-slot="resource-row"
      data-state={state}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 max-sm:flex max-sm:flex-col max-sm:gap-1.5 max-sm:py-3",
        problem && "bg-destructive/5 hover:bg-destructive/10",
        className,
      )}
      {...props}
    />
  );
}

/** One cell. `label` is the column's name, shown before the value when the row is a stacked card. */
export function ResourceCell({
  from,
  label,
  className,
  children,
}: {
  from?: ColumnFrom;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <td
      data-label={label}
      className={cn(
        "p-2 align-middle max-sm:items-baseline max-sm:gap-x-2 max-sm:px-4 max-sm:py-0 max-sm:whitespace-normal",
        from ? FROM[from] : "max-sm:flex",
        label && STACKED_LABEL,
        className,
      )}
    >
      <div className="min-w-0">{children}</div>
    </td>
  );
}
