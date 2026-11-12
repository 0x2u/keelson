import Link from "next/link";
import { BoxIcon, PlugIcon } from "lucide-react";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { newProjectHref } from "@/lib/nav-core";

/** What "From a repository" shows when the dashboard has no GitHub App yet: what GitHub gives, where to set it up, and the way that needs none. */
export function GithubRequiredNotice({ server }: { server?: string }) {
  return (
    <Notice
      tone="info"
      title="GitHub is not connected yet"
      action={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href="/settings/integrations">
              <PlugIcon />
              Open Integrations
            </Link>
          </Button>
          <Button asChild size="sm" className="w-fit">
            <Link href={newProjectHref({ door: "image", ...(server ? { server } : {}) })}>
              <BoxIcon />
              Use an image instead
            </Link>
          </Button>
        </div>
      }
    >
      Repositories come from the GitHub App, which gives deploy on push and previews of pull requests. Connecting it needs the dashboard to have an https address; Integrations says how. It is optional: a ready-made image
      deploys without GitHub.
    </Notice>
  );
}
