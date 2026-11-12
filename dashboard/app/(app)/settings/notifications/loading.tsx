import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the notifications page: title block, the default's card, the toolbar, then the table of servers. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading notification settings">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-6">
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-9 w-64 max-w-full" />
            <Skeleton className="h-9 w-96 max-w-full" />
          </div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
