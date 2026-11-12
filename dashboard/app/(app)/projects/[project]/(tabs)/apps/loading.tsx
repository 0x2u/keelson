import { HealthSkeleton, skeletonRoot } from "@/components/ServerSkeleton";

export default function Loading() {
  return (
    <div className="space-y-6" {...skeletonRoot("Loading apps")}>
      <HealthSkeleton rows={2} />
      <HealthSkeleton rows={2} />
    </div>
  );
}
