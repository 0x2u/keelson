"use client";

import { ArrowRightIcon } from "lucide-react";
import { ICONS } from "@/lib/icons";
import { usePathname, useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { deployAction, rollbackAction, type DeployState } from "@/app/actions";
import { buildAction } from "@/app/github-actions";
import type { Deployment } from "@/lib/agent-types";
import { deployInput, splitRef, versionOf } from "@/lib/image-ref-core";
import { initialDeployMode } from "@/lib/build-now-core";
import { deployChange, recentVersions, rollbackPlan } from "@/lib/rollback-core";
import { deploymentToast } from "@/lib/toast-core";
import { ImageRef, VersionChip } from "@/components/image-ref";
import { useOpenOutcome } from "@/components/outcome-toast";
import { ChoiceList } from "@/components/projects/ChoiceList";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DisabledWithReason, GatedButton } from "@/components/GatedButton";
import { StepUpAction } from "@/components/unlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/states";

// The same rules as the server action.
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function refError(ref: string): string | null {
  const value = ref.trim();
  if (value === "") return "Enter a tag or a digest.";
  if (value.startsWith("sha256:")) {
    return DIGEST.test(value) ? null : "A digest is sha256: followed by 64 lowercase hex characters.";
  }
  return TAG.test(value) ? null : "A tag may use letters, digits, _ . - and be at most 128 characters.";
}

/**
 * A control of the deploy bar: "Read-only server" when the server cannot deploy, the reason in a focusable tooltip when
 * something else blocks it, a plain button otherwise.
 */
function Action({ canDeploy, reason, ...props }: Omit<React.ComponentProps<typeof GatedButton>, "stepUp"> & { reason: string | null }) {
  if (canDeploy && reason !== null) {
    return (
      <DisabledWithReason reason={reason}>
        <Button {...props} disabled />
      </DisabledWithReason>
    );
  }
  return <GatedButton canDeploy={canDeploy} {...props} />;
}

/** A version as a chip with the repository next to it, for "from → to" lines. */
function Version({ label }: { label: string }) {
  return label === "" ? <span className="text-muted-foreground">nothing running</span> : <VersionChip tag={label} />;
}

function Change({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Version label={from} />
      <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <Version label={to} />
    </span>
  );
}

/** Where an app's code comes from when it builds from a linked repository: what the Deploy dialog offers besides an image version. */
export interface DeploySource {
  repo: string;
  branch: string;
  /** Why the latest commit cannot be deployed now (read-only server, GitHub App missing, not linked, a deploy running), or null. */
  blocked: string | null;
  /** Said when the build runs on another server and values of the app do not reach it. */
  warning?: { title: string; body: string } | null;
}

interface Versions {
  serverId: string;
  app: string;
  /** The image of the container that serves now; empty when none does. */
  current: string;
  /** The app's deployments, newest first; null when they could not be loaded. */
  history: Deployment[] | null;
}

function DeployDialog({
  serverId,
  app,
  current,
  history,
  source,
  initialRef,
  open,
  onOpenChange,
}: Versions & { source: DeploySource | null; initialRef: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [imageState, imageAction, imagePending] = useActionState<DeployState, FormData>(deployAction.bind(null, serverId, app), {});
  const [sourceState, sourceAction, sourcePending] = useActionState<DeployState, FormData>(buildAction.bind(null, serverId, app), {});
  // From source (the latest commit of the linked branch) is the default where it can be used; a `?deploy=<tag>` link means an image.
  const [mode, setMode] = useState(initialDeployMode(source, initialRef));
  const fromSource = source !== null && mode === "source";
  const state = fromSource ? sourceState : imageState;
  const pending = imagePending || sourcePending;
  const [ref, setRef] = useState(initialRef);
  const [touched, setTouched] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const openOutcome = useOpenOutcome();

  useEffect(() => {
    // A refusal is shown inside the dialog (below), not here: one failure, one place.
    if (imageState.deploymentId) {
      const change = deployChange(current, ref);
      openOutcome(deploymentToast("deploy", { serverId, deploymentId: imageState.deploymentId, app, from: change.from || undefined, to: change.to }));
    }
    // Only the answer matters: the typed text and the router are read as they were when it came.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageState]);

  useEffect(() => {
    if (sourceState.deploymentId && source !== null) {
      openOutcome(deploymentToast("deploy", { serverId: sourceState.serverId ?? serverId, deploymentId: sourceState.deploymentId, app, from: current ? versionOf(current) : undefined, to: source.branch }));
    }
    // Only the answer matters, as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceState]);

  const invalid = touched ? refError(ref) : null;
  const valid = refError(ref) === null;
  const change = deployChange(current, ref);
  const recent = history === null ? [] : recentVersions(history, current);

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form
          action={fromSource ? sourceAction : imageAction}
          onSubmit={(event) => {
            if (fromSource) return;
            setTouched(true);
            if (refError(ref) !== null) event.preventDefault();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Deploy {app}</DialogTitle>
            <DialogDescription>{fromSource ? `Build the latest commit of ${source.branch} and run it.` : "Choose the image version to run."}</DialogDescription>
          </DialogHeader>

          {source !== null && (
            <ChoiceList
              id={`${inputId}-what`}
              label="What to deploy"
              value={mode}
              onChange={(value) => setMode(value === "source" ? "source" : "image")}
              choices={[
                {
                  value: "source",
                  label: (
                    <>
                      Latest commit of <span className="font-mono">{source.branch}</span>
                    </>
                  ),
                  detail: source.blocked ?? <span className="font-mono">{source.repo}</span>,
                  disabled: source.blocked !== null,
                },
                { value: "image", label: "An image version", detail: "A tag or a digest that was built before." },
              ]}
            />
          )}

          {fromSource && (
            <>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <p className="mb-1.5 font-medium">What will happen</p>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>The server downloads the commit from GitHub and builds it with Docker, within the memory and CPU limits of the app&apos;s <span className="font-mono">build:</span> block.</li>
                  <li>The release steps run, if the app defines any.</li>
                  <li>The new container starts and must pass its health check before traffic switches.</li>
                  <li>If anything fails, the running version keeps serving.</li>
                </ol>
              </div>
              {source.warning && (
                <p className="text-sm text-warning-text" data-testid="build-warning">
                  <strong>{source.warning.title}.</strong> {source.warning.body}
                </p>
              )}
            </>
          )}

          {!fromSource && recent.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm font-medium" id={`${inputId}-recent`}>
                Deployed before
              </p>
              <ul aria-labelledby={`${inputId}-recent`} className="grid gap-1.5">
                {recent.map((r) => {
                  const value = deployInput(r.ref);
                  const selected = value !== "" && value === ref.trim();
                  return (
                    <li key={r.ref}>
                      <button
                        type="button"
                        disabled={value === ""}
                        aria-pressed={selected}
                        onClick={() => {
                          setRef(value);
                          setTouched(true);
                        }}
                        className={cn(
                          "flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                          selected && "border-primary bg-accent",
                        )}
                      >
                        <VersionChip tag={splitRef(r.ref).tag} digest={splitRef(r.ref).digest} />
                        {r.serving && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-success">serving</span>}
                        <span className="ml-auto text-xs text-muted-foreground">
                          <RelativeTime at={r.at} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {!fromSource && history === null && <p className="text-xs text-muted-foreground">The deploy history could not be loaded, so earlier versions are not listed. You can still type one.</p>}

          {!fromSource && (
          <div className="grid gap-2">
            <Label htmlFor={inputId}>Tag or digest</Label>
            <Input
              id={inputId}
              name="ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="v1.4.2 or sha256:…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="font-mono"
              aria-invalid={invalid !== null}
              aria-describedby={invalid !== null ? `${hintId} ${errorId}` : hintId}
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              A tag such as v1.4.2 or a commit SHA, or an exact digest (sha256: and 64 hex characters).
            </p>
            {invalid !== null && (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {invalid}
              </p>
            )}
          </div>
          )}

          {!fromSource && valid && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm" aria-live="polite">
              <p className="mb-1.5 font-medium">What will change</p>
              <Change from={change.from} to={change.to} />
              {change.same && <p className="mt-2 text-muted-foreground">This version already serves: deploying it starts a fresh container from the same image.</p>}
            </div>
          )}

          {!fromSource && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="mb-1.5 font-medium">What will happen</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>The agent pulls the image.</li>
                <li>The release steps run, if the app defines any.</li>
                <li>The new container starts and must pass its health check before traffic switches.</li>
                <li>If anything fails, the previous version is restored automatically.</li>
              </ol>
            </div>
          )}

          {state.error && (
            <div className="grid gap-2">
              <Notice title="Could not deploy">{state.error}</Notice>
              <div>
                <StepUpAction error={state.error} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              <ICONS.deploy />
              Deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RollbackDialog({ serverId, app, current, history, open, onOpenChange }: Versions & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const openOutcome = useOpenOutcome();
  const plan = history === null ? null : rollbackPlan(history, current);
  const target = plan?.ok ? plan.target : null;
  const servingSince = history?.find((d) => d.status === "succeeded" && d.ref === current);

  function rollback() {
    setError(null);
    start(async () => {
      const result = await rollbackAction(serverId, app);
      if (result.error) {
        setError(result.error);
      } else if (result.deploymentId) {
        onOpenChange(false);
        openOutcome(deploymentToast("rollback", { serverId, deploymentId: result.deploymentId, app, from: current ? versionOf(current) : undefined, to: target ? versionOf(target.ref) : "the previous version" }));
      }
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null);
        onOpenChange(next);
      }}
      title={target ? `Roll back ${app} to ${versionOf(target.ref)}?` : `Roll back ${app}?`}
      description="The agent deploys the most recent successful version that is different from the one running now. The same health gate applies, and the running version is replaced only once the older one is healthy."
      confirmLabel={target ? `Roll back to ${versionOf(target.ref)}` : "Roll back"}
      destructive
      pending={pending}
      error={error}
      onConfirm={rollback}
    >
      {target ? (
        <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <Change from={current ? versionOf(current) : ""} to={versionOf(target.ref)} />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-muted-foreground">
            <dt>Now</dt>
            <dd className="min-w-0">
              {current ? <ImageRef value={current} copy={false} /> : "nothing running"}
              {servingSince && (
                <>
                  {" "}
                  · deployed <RelativeTime at={servingSince.started_at} />
                </>
              )}
            </dd>
            <dt>Back to</dt>
            <dd className="min-w-0">
              <ImageRef value={target.ref} copy={false} /> · deployed <RelativeTime at={target.started_at} />
            </dd>
          </dl>
        </div>
      ) : (
        <Notice tone="warning" title="The target could not be shown">
          The deployment history could not be loaded. The agent still picks the most recent successful version that differs from the running one, and refuses if there is none.
        </Notice>
      )}
    </ConfirmDialog>
  );
}

/**
 * Deploy and Roll back for one app. Both are confirmed in a dialog that says what will change: the version serving now and
 * the one that comes next. Deploy offers the latest commit of the linked branch (an app that builds from a repository) or
 * an image version. `initialRef` (the `?deploy=` of the page) opens the deploy dialog prefilled with an image version,
 * `initialRollback` (`?rollback=1`) the roll back one. Roll back is not offered for an app that was never deployed, and
 * is off, with the reason, when there is no other version to go back to.
 */
export function DeployControls({
  serverId,
  app,
  canDeploy,
  running,
  current,
  history,
  neverDeployed,
  source,
  initialRef,
  initialRollback = false,
}: {
  serverId: string;
  app: string;
  canDeploy: boolean;
  running: boolean;
  current: string;
  history: Deployment[] | null;
  neverDeployed: boolean;
  /** Set for an app that builds from a linked repository: Deploy then offers its latest commit as well as an image version. */
  source: DeploySource | null;
  initialRef?: string;
  /** The `?rollback=1` of the page (the command palette's "Roll back"): opens the roll back confirmation. Nothing is rolled back until it is confirmed. */
  initialRollback?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [deployOpen, setDeployOpen] = useState(initialRef !== undefined);
  const blocked = running ? "A deployment is running. Wait for it to finish before starting another." : null;
  const plan = history === null ? null : rollbackPlan(history, current);
  const rollbackReason = blocked ?? (plan !== null && !plan.ok ? plan.reason : null);
  // Without a target the dialog is never offered: the button says why instead.
  const [rollbackOpen, setRollbackOpen] = useState(initialRollback && canDeploy && rollbackReason === null);

  function onDeployOpenChange(open: boolean) {
    setDeployOpen(open);
    // The prefilled link is spent once the dialog closes: drop it so a reload does not reopen it.
    if (!open && initialRef !== undefined) router.replace(pathname, { scroll: false });
  }

  function onRollbackOpenChange(open: boolean) {
    setRollbackOpen(open);
    // Like the prefilled deploy link: spent once the dialog closes.
    if (!open && initialRollback) router.replace(pathname, { scroll: false });
  }

  return (
    <>
      {!neverDeployed && (
        <Action canDeploy={canDeploy} reason={rollbackReason} variant="outline" onClick={() => setRollbackOpen(true)}>
          <ICONS.rollback />
          Roll back
        </Action>
      )}
      <Action canDeploy={canDeploy} reason={blocked} onClick={() => setDeployOpen(true)}>
        <ICONS.deploy />
        Deploy
      </Action>
      {canDeploy && blocked === null && (
        <>
          <DeployDialog key={initialRef ?? ""} serverId={serverId} app={app} current={current} history={history} source={source} initialRef={initialRef ?? ""} open={deployOpen} onOpenChange={onDeployOpenChange} />
          {rollbackReason === null && <RollbackDialog serverId={serverId} app={app} current={current} history={history} open={rollbackOpen} onOpenChange={onRollbackOpenChange} />}
        </>
      )}
    </>
  );
}
