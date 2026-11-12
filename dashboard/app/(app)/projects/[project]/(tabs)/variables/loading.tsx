import { HealthSkeleton, skeletonRoot } from "@/components/ServerSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" {...skeletonRoot("Loading variables")}>
      <Skeleton className="h-9 w-64" aria-hidden />
      <HealthSkeleton rows={3} />
    </div>
  );
}
