import { PageSkeleton } from "@/components/ServerSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the projects page: heading with the New project button, then the grid of project cards. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading projects" breadcrumbs={false} action>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    </PageSkeleton>
  );
}
