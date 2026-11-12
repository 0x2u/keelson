import { HealthSkeleton } from "@/components/ServerSkeleton";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading the server">
      <HealthSkeleton rows={1} />
      <HealthSkeleton rows={4} />
      <HealthSkeleton rows={4} />
    </div>
  );
}
