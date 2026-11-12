import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like the uninstall page: heading, then the wizard's card. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading the agent uninstall">
      <div className="max-w-3xl">
        <FormCardSkeleton fields={2} />
      </div>
    </PageSkeleton>
  );
}
