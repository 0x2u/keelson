import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like server settings: heading, then the agent, connection and apps domain cards and the danger zone. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading server settings">
      <div className="space-y-10">
        <FormCardSkeleton fields={1} />
        <FormCardSkeleton fields={4} />
        <FormCardSkeleton fields={1} />
        <FormCardSkeleton fields={1} />
      </div>
    </PageSkeleton>
  );
}
