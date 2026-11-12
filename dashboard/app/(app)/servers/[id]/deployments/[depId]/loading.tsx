import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading deployment">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-80" />
      </div>
      <div className="space-y-6">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-[30rem] rounded-xl" />
      </div>
    </div>
  );
}
