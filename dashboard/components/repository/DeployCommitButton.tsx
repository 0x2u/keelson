"use client";

import { ICONS } from "@/lib/icons";
import { useState, useTransition } from "react";
import { deployAction } from "@/app/actions";
import { buildAction } from "@/app/github-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledWithReason } from "@/components/GatedButton";
import { useOpenOutcome } from "@/components/outcome-toast";
import { Button } from "@/components/ui/button";
import type { BuildWarning } from "@/lib/build-elsewhere-core";
import { deploymentToast } from "@/lib/toast-core";

/**
 * Deploys one commit of the linked repository: the image tagged with its SHA (the tag CI pushes), or, for an app that
 * builds from its repository (`builds`), a build of the commit. Disabled with a reason when it cannot be used.
 */
export function DeployCommitButton({
  serverId,
  app,
  sha,
  message,
  blocked,
  builds = null,
}: {
  serverId: string;
  app: string;
  sha: string;
  message: string;
  blocked: string | null;
  /** Set for an app that builds from its repository; `warning` is said when the build runs on another server and values of the app do not reach it. */
  builds?: { warning: BuildWarning | null } | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openOutcome = useOpenOutcome();

  function deploy() {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set(builds ? "sha" : "ref", sha);
      const state = builds ? await buildAction(serverId, app, {}, form) : await deployAction(serverId, app, {}, form);
      if (state.error) {
        setError(state.error);
        return;
      }
      if (state.deploymentId) {
        setOpen(false);
        openOutcome(deploymentToast("deploy", { serverId: state.serverId ?? serverId, deploymentId: state.deploymentId, app, to: sha.slice(0, 7) }));
      }
    });
  }

  const button = (
    <Button variant="outline" size="sm" disabled={blocked !== null}>
      <ICONS.deploy />
      Deploy
    </Button>
  );

  if (blocked !== null) return <DisabledWithReason reason={blocked}>{button}</DisabledWithReason>;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
      trigger={button}
      title={
        <>
          Deploy <span className="font-mono">{sha.slice(0, 7)}</span> to {app}
        </>
      }
      description={
        <>
          {message}
          {builds ? (
            <>
              <span className="mt-2 block">
                The server downloads the commit from GitHub, builds it with Docker (within the memory and CPU limits of the app&apos;s <span className="font-mono">build:</span> block), runs the
                release steps and switches to the new version once it is healthy. If anything fails before the switch, the running version keeps serving.
              </span>
              {builds.warning && (
                <span
                  className="mt-2 block text-warning-text"
                  data-testid="build-warning"
                >
                  <strong>{builds.warning.title}.</strong> {builds.warning.body}{" "}
                  <a
                    href={builds.warning.href}
                    onClick={() => setOpen(false)}
                    className="underline underline-offset-4"
                  >
                    Set them in the build variables
                  </a>
                </span>
              )}
            </>
          ) : (
            <span className="mt-2 block">
              The server pulls the image tagged <span className="font-mono">{sha.slice(0, 12)}…</span> and switches to it once it is healthy. If the image is not in the registry,
              nothing changes.
            </span>
          )}
        </>
      }
      confirmLabel="Deploy"
      pending={pending}
      error={error}
      onConfirm={deploy}
    />
  );
}
