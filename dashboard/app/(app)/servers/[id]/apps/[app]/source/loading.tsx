import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like an app's source page: heading, then the repository, commits and automatic deploy cards. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading the app source" action>
      <div className="space-y-6">
        <FormCardSkeleton fields={2} />
        <FormCardSkeleton fields={3} />
        <FormCardSkeleton fields={2} />
      </div>
    </PageSkeleton>
  );
}
