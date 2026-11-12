import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the jobs page: title block, summary badges, then a table of rows. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading jobs">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="rounded-xl border bg-card">
          <div className="flex h-10 items-center gap-6 border-b px-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="hidden h-3 w-16 md:block" />
            <Skeleton className="hidden h-3 w-16 lg:block" />
            <Skeleton className="ml-auto h-3 w-20 md:ml-0" />
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-[69px] items-center gap-6 border-b px-4 last:border-b-0">
              <div className="min-w-0 flex-1 space-y-2 md:flex-none md:basis-56">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44 max-w-full" />
              </div>
              <Skeleton className="hidden h-4 w-24 md:block" />
              <Skeleton className="hidden h-4 w-24 lg:block" />
              <Skeleton className="hidden h-4 w-16 md:block" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-8 w-20 md:ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
