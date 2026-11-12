import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-9 w-56" />
        </div>
        <Skeleton className="h-[min(70vh,40rem)] min-h-64 w-full" />
      </div>
    </div>
  );
}
