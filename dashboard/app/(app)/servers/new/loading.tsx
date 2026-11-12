import { PageSkeleton } from "@/components/ServerSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the add-server page: the one-command card, then the folded Advanced row. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading the add server page">
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    </PageSkeleton>
  );
}
