import { HealthSkeleton, skeletonRoot } from "@/components/ServerSkeleton";

export default function Loading() {
  return (
    <div {...skeletonRoot("Loading configuration")}>
      <HealthSkeleton rows={2} />
    </div>
  );
}
