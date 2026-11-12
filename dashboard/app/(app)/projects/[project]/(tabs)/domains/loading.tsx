import { skeletonRoot, TableCardSkeleton } from "@/components/ServerSkeleton";

export default function Loading() {
  return (
    <div className="space-y-6" {...skeletonRoot("Loading domains")}>
      <TableCardSkeleton title rows={3} />
      <TableCardSkeleton title rows={2} />
    </div>
  );
}
