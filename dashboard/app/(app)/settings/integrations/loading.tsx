import { FormCardSkeleton, PageSkeleton } from "@/components/ServerSkeleton";

/** Shaped like integrations: heading with the New project action, then one card per service. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading integrations" action>
      <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
        <FormCardSkeleton fields={2} />
        <FormCardSkeleton fields={2} />
      </div>
    </PageSkeleton>
  );
}
