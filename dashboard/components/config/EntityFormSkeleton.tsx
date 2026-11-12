import { FormCardSkeleton, PageHeaderSkeleton, skeletonRoot } from "@/components/ServerSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** The shape of a configuration form page: breadcrumb and title, then cards of fields. */
export function EntityFormSkeleton({ label, cards = 3 }: { label: string; cards?: number }) {
  return (
    <div {...skeletonRoot(label)}>
      <Skeleton className="mb-3 h-4 w-64" aria-hidden />
      <PageHeaderSkeleton />
      <div className="max-w-3xl space-y-6">
        {Array.from({ length: cards }, (_, i) => (
          <FormCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
