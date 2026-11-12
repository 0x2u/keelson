import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the security page: title block, then one card per section. */
export default function Loading() {
  const cards = [
    { title: "w-40", body: "h-9 w-44" },
    { title: "w-24", body: "h-24 w-full" },
    { title: "w-36", body: "h-9 w-44" },
    { title: "w-36", body: "h-32 w-full" },
    { title: "w-36", body: "h-48 w-full" },
  ];
  return (
    <div role="status" aria-busy="true" aria-label="Loading security settings">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid max-w-5xl gap-6">
        {cards.map((c, i) => (
          <div key={i} className="space-y-4 rounded-xl border bg-card p-6">
            <div className="space-y-2">
              <Skeleton className={`h-4 ${c.title}`} />
              <Skeleton className="h-4 w-full max-w-lg" />
            </div>
            <Skeleton className={c.body} />
          </div>
        ))}
      </div>
    </div>
  );
}
