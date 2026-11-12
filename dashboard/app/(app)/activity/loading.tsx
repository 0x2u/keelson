import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the activity page: title block, the filter chips, then rows of events. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading activity">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <div className="rounded-xl border bg-card">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-[65px] items-center gap-3 border-b px-4 last:border-b-0">
            <Skeleton className="size-7 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="hidden h-4 w-14 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
