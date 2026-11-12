import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the backup page: title block, the download card, the notice. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading backup settings">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid max-w-3xl gap-6">
        <div className="space-y-4 rounded-xl border bg-card p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-44" />
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
