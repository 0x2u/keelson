"use client";

import { ExternalLinkIcon, LockIcon, RefreshCwIcon } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { removeGithubAppAction } from "@/app/github-actions";
import { refreshInstallationsAction } from "@/app/github-connect-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { GithubConnectForm } from "@/components/repository/GithubConnectForm";
import { Notice } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appSettingsUrl, installUrl } from "@/lib/github-connect-core";
import { toastCopy } from "@/lib/toast-core";

export interface InstalledRepoView {
  fullName: string;
  private: boolean;
}

export interface IntegrationApp {
  appId: string;
  slug: string | null;
  name: string | null;
  owner: { login: string; type: string } | null;
}

/** What is known of the App's installations: absent when GitHub could not be asked (`error` says why). */
export interface InstallationsView {
  installations: number;
  repos: InstalledRepoView[];
  truncated: boolean;
  warnings: string[];
}

export interface GithubIntegrationCardProps {
  app: IntegrationApp | null;
  installations: InstallationsView | null;
  /** Why the installations could not be read (GitHub unreachable, credentials refused). */
  error: string | null;
  defaultName: string;
  /** Set when KEELSON_PUBLIC_URL is missing or not https: Connect GitHub is off and this says why. */
  publicUrlProblem: string | null;
  /** A webhook secret or an App already exists, so connecting replaces them. */
  replacing: boolean;
}

const WHAT_IS_REQUESTED =
  "Keelson asks GitHub for a private App owned by you with the least access it needs: read the code (Contents), read pull requests, write commit statuses, and read repository metadata. It listens to pushes and pull requests. Nothing else.";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
      {children} <ExternalLinkIcon className="size-3" />
    </a>
  );
}

function RefreshButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="outline" loading={pending} onClick={() => startTransition(() => refreshInstallationsAction())}>
      <RefreshCwIcon />
      Refresh
    </Button>
  );
}

/**
 * GitHub, in one card: Connect GitHub when nothing is set up, the way to install the App when it is not installed
 * anywhere yet, and the App with its repositories once it is. The manual credentials live under Advanced.
 */
export function GithubIntegrationCard({ app, installations, error, defaultName, publicUrlProblem, replacing }: GithubIntegrationCardProps) {
  const [confirming, setConfirming] = useState<"remove" | "replace" | null>(null);
  const [removing, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      await removeGithubAppAction();
      setConfirming(null);
      toast.success(toastCopy.removed("GitHub App"));
    });
  }

  const installed = app !== null && installations !== null && installations.installations > 0;
  const settings = app?.slug ? appSettingsUrl(app.slug, app.owner) : null;
  const install = app?.slug ? installUrl(app.slug) : null;
  const badge = app === null ? ["muted", "Not connected"] : installed ? ["success", "Connected"] : error ? ["warning", "Not checked"] : ["warning", "Not installed yet"];

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
        <CardDescription>
          {app === null
            ? "Connect GitHub once and choose a repository from a list to deploy it. There is nothing to copy between GitHub and this dashboard."
            : "Keelson builds and deploys from the pushes and pull requests of the repositories this App is installed on. The server's agent downloads the source with a short-lived token and builds it with Docker."}
        </CardDescription>
        <CardAction>
          <Badge variant={badge[0] as "muted" | "success" | "warning"}>{badge[1]}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {app === null ? (
          <>
            <p className="text-sm text-muted-foreground">{WHAT_IS_REQUESTED}</p>
            <GithubConnectForm defaultName={defaultName} replacing={replacing} disabledReason={publicUrlProblem} />
          </>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">{app.name ?? app.slug ?? `App ${app.appId}`}</span>
              {app.owner ? <span className="text-muted-foreground"> · owned by {app.owner.login}</span> : null}
              <span className="text-muted-foreground"> · App ID {app.appId}</span>
              {settings ? (
                <>
                  {" · "}
                  <ExternalLink href={settings}>Settings on GitHub</ExternalLink>
                </>
              ) : null}
            </p>

            {error && (
              <Notice title="Could not ask GitHub about the installations">
                {error}
              </Notice>
            )}

            {!error && !installed && (
              <Notice tone="info" title="Install the App to choose repositories">
                The App exists but is not installed anywhere yet. Install it on your account or organization, on all repositories or only the ones you deploy; GitHub
                brings you back here afterwards.
                {install ? (
                  <span className="mt-3 block">
                    <Button asChild>
                      <a href={install}>Install the App on GitHub</a>
                    </Button>
                  </span>
                ) : (
                  <span className="mt-2 block">This App&apos;s name is not known: set it under Advanced / manual setup.</span>
                )}
              </Notice>
            )}

            {installed && installations && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {installations.repos.length === 0
                    ? "The App is installed, but on no repository yet."
                    : `${installations.repos.length}${installations.truncated ? "+" : ""} installed ${installations.repos.length === 1 ? "repository" : "repositories"}`}
                </p>
                {installations.repos.length > 0 && (
                  <ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm" aria-label="Installed repositories">
                    {installations.repos.map((r) => (
                      <li key={r.fullName} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="min-w-0 truncate font-mono text-xs">{r.fullName}</span>
                        {r.private && (
                          <Badge variant="muted">
                            <LockIcon /> private
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {installations.truncated && <p className="text-xs text-muted-foreground">Only the first 500 repositories are listed.</p>}
                {installations.warnings.map((w) => (
                  <Notice key={w} tone="warning">
                    {w}
                  </Notice>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {install && installed && (
                <Button variant="outline" asChild>
                  <a href={install}>Install on more repositories</a>
                </Button>
              )}
              <RefreshButton />
              <Button variant="outline" onClick={() => setConfirming("replace")}>
                Create a new App instead
              </Button>
              <Button variant="outline" onClick={() => setConfirming("remove")}>
                Disconnect
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming === "remove"}
        onOpenChange={(open) => setConfirming(open ? "remove" : null)}
        title="Disconnect the GitHub App"
        description="The stored key is deleted and every app's builds are turned off. Delete the App, or its private key, on GitHub too if you no longer need it."
        confirmLabel="Disconnect"
        destructive
        pending={removing}
        onConfirm={remove}
      />

      <Dialog open={confirming === "replace"} onOpenChange={(open) => setConfirming(open ? "replace" : null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a new GitHub App</DialogTitle>
            <DialogDescription>{WHAT_IS_REQUESTED}</DialogDescription>
          </DialogHeader>
          <GithubConnectForm defaultName={defaultName} replacing disabledReason={publicUrlProblem} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
