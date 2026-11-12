import { BoxIcon, GitBranchIcon, PlugIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { newProjectHref } from "@/lib/nav-core";

function Door({ icon: Icon, title, description, children, footer, first }: { icon: typeof BoxIcon; title: string; description: string; children?: ReactNode; footer: ReactNode; first?: boolean }) {
  return (
    <Card className={first ? "order-first min-w-0" : "min-w-0"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon aria-hidden className="size-5 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children && <CardContent className="space-y-2 text-sm text-muted-foreground">{children}</CardContent>}
      <CardFooter className="mt-auto">{footer}</CardFooter>
    </Card>
  );
}

/**
 * The two ways to a project: a repository (GitHub builds on push) and a ready-made image. Both are always shown: the
 * repository door says what GitHub gives and where to set it up when it is not connected, and the image door never needs it.
 */
export function NewProjectDoors({ githubConnected, server }: { githubConnected: boolean; server?: string }) {
  return (
    <div className="grid max-w-3xl gap-4 md:grid-cols-2" data-testid="doors">
      <Door
        icon={GitBranchIcon}
        title="From a repository"
        description="Pick a repository on GitHub: Keelson builds it on your server and deploys it."
        footer={
          githubConnected ? (
            <Button asChild>
              <Link href={newProjectHref({ door: "repository", ...(server ? { server } : {}) })}>Choose a repository</Link>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/settings/integrations">
                <PlugIcon />
                Set up GitHub
              </Link>
            </Button>
          )
        }
      >
        {githubConnected ? (
          <p>Pushes to a branch deploy by themselves, and each pull request can get a preview.</p>
        ) : (
          <>
            <p>
              GitHub gives you <span className="font-medium text-foreground">deploy on push</span> and <span className="font-medium text-foreground">previews of pull requests</span>, with no CI to write.
            </p>
            <p>GitHub is not connected yet. Connecting needs the dashboard to have an https address; Integrations says how.</p>
          </>
        )}
      </Door>
      <Door
        first={!githubConnected}
        icon={BoxIcon}
        title="From an image"
        description="Run a ready-made image from Docker Hub or another registry, such as traefik/whoami:v1.10.3."
        footer={
          <Button asChild variant={githubConnected ? "outline" : "default"}>
            <Link href={newProjectHref({ door: "image", ...(server ? { server } : {}) })}>Use an image</Link>
          </Button>
        }
      >
        <p>
          <span className="font-medium text-foreground">No GitHub needed.</span> Name it, choose the tag, the server and the port, and Keelson deploys it. You can add a domain and variables, now or later.
        </p>
      </Door>
    </div>
  );
}
