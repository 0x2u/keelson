import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like a page: a title block, then content. Specific routes add their own when the shape differs. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
