import { CompassIcon } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="pt-12">
      <EmptyState
        icon={CompassIcon}
        title="Not found"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/">Back to the overview</Link>
          </Button>
        }
      >
        This server, app or job does not exist, or it has been removed.
      </EmptyState>
    </div>
  );
}
