import { HealthSkeleton } from "@/components/ServerSkeleton";

export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-busy="true" aria-label="Loading project">
      <HealthSkeleton rows={3} />
      <HealthSkeleton rows={2} />
    </div>
  );
}
