import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like the new-project wizard: heading, then the first step's card. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading the new project form">
      <div className="max-w-3xl space-y-6">
        <FormCardSkeleton fields={3} />
      </div>
    </PageSkeleton>
  );
}
