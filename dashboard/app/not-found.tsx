import { CompassIcon } from "lucide-react";
import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";

/** An address that matches no page at all (the pages of the app have their own, inside the shell). */
export default function NotFound() {
  return (
    <AuthShell wide>
      <EmptyState
        icon={CompassIcon}
        title="Page not found"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm">
              <Link href="/">Back to Home</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/projects">Projects</Link>
            </Button>
          </div>
        }
      >
        There is no page at this address. Check it for a typo, or start from Home.
      </EmptyState>
    </AuthShell>
  );
}
