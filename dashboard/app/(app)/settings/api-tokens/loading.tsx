import { PageSkeleton, TableCardSkeleton } from "@/components/ServerSkeleton";

/** Shaped like API tokens: heading, then the card of tokens. */
export default function Loading() {
  return (
    <PageSkeleton label="Loading API tokens">
      <div className="grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
        <TableCardSkeleton title rows={3} />
      </div>
    </PageSkeleton>
  );
}
