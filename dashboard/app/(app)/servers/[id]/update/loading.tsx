import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like the update page: heading, then the install wizard's card. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading the agent update">
      <div className="max-w-3xl space-y-6">
        <FormCardSkeleton fields={3} />
      </div>
    </PageSkeleton>
  );
}
