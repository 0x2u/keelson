import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the delivery page: title block, the window chips, the four measures, then the per-server table. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the delivery numbers">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-[40rem] max-w-full" />
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border bg-card">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex h-[49px] items-center gap-6 border-b px-4 last:border-b-0">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
