"use client";

import { useMemo, useState, type ComponentProps } from "react";
import { addEnvironmentAction } from "@/app/project-lifecycle-actions";
import { DisabledWithReason } from "@/components/GatedButton";
import { IssuesList } from "@/components/config/IssuesList";
import { saveFailure, useConfigSave } from "@/components/config/useConfigSave";
import { SelectField, TextField, ERROR_TEXT } from "@/components/forms/fields";
import { ChoiceList } from "@/components/projects/ChoiceList";
import { useIntentDialog } from "@/components/projects/useIntentDialog";
import { Notice } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StepUpAction } from "@/components/unlock";
import type { ConfigIssue } from "@/lib/agent-types";
import { listFields } from "@/lib/app-config-core";
import { ICONS } from "@/lib/icons";
import { planAddEnvironment, type AddEnvironmentPlanned, type CopySource, type ServerChoice } from "@/lib/project-lifecycle-core";

/** An app of the project that an environment can be copied from. */
export interface EnvironmentSource extends CopySource {
  environment: string;
  /** The environment the project is judged by (the first one): the default of "Copy from". */
  primary: boolean;
  key: string;
}

const NONE = "none";

type ButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size">;

/**
 * "Add environment": asks for the name, the server and which environment to copy from, shows what would be written and what
 * is not copied, and only then writes the app (it is not deployed: it appears in the Apps tab as "Not deployed").
 */
export function AddEnvironmentButton({
  project,
  environments,
  sources,
  servers,
  appNames,
  intent = false,
  variant = "outline",
  size,
}: {
  project: string;
  /** The environments the project has. */
  environments: string[];
  sources: EnvironmentSource[];
  servers: ServerChoice[];
  /** The names of the apps on each server, to make the new app's name unique. */
  appNames: Record<string, string[]>;
  intent?: boolean;
} & ButtonProps) {
  const [open, setOpen] = useIntentDialog(intent);
  if (servers.every((s) => !s.enabled)) {
    return (
      <DisabledWithReason reason={servers[0]?.reason ?? "No server can run apps yet"}>
        <Button variant={variant} size={size} disabled aria-disabled>
          <ICONS.add />
          Add environment
        </Button>
      </DisabledWithReason>
    );
  }
  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={() => setOpen(true)}>
        <ICONS.add />
        Add environment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <EnvironmentForm project={project} environments={environments} sources={sources} servers={servers} appNames={appNames} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function EnvironmentForm({
  project,
  environments,
  sources,
  servers,
  appNames,
  onDone,
}: {
  project: string;
  environments: string[];
  sources: EnvironmentSource[];
  servers: ServerChoice[];
  appNames: Record<string, string[]>;
  onDone: () => void;
}) {
  const save = useConfigSave();
  const [step, setStep] = useState<"form" | "review">("form");
  const [environment, setEnvironment] = useState("");
  const [serverId, setServerId] = useState(servers.find((s) => s.enabled)?.id ?? "");
  const [copy, setCopy] = useState(sources.find((s) => s.primary)?.key ?? sources[0]?.key ?? NONE);
  const [image, setImage] = useState("");
  const [error, setError] = useState<{ message: string | null; issues: ConfigIssue[] } | null>(null);

  const source = copy === NONE ? null : (sources.find((s) => s.key === copy) ?? null);
  const server = servers.find((s) => s.id === serverId);
  const plan = useMemo(
    () =>
      planAddEnvironment({
        project,
        environment,
        server: { id: serverId, name: server?.name ?? serverId, canDeploy: server?.enabled ?? false },
        from: source,
        image,
        existingEnvironments: environments,
        existingAppNames: appNames[serverId] ?? [],
      }),
    [project, environment, serverId, server, source, image, environments, appNames],
  );
  const issue = environment.trim() === "" || plan.ok ? null : plan.reason;

  async function add() {
    if (!plan.ok) return;
    setError(null);
    const { saved, result } = await save.run(
      plan.appName,
      () => addEnvironmentAction({ project, environment, serverId, from: source === null ? null : { serverId: source.server.id, app: source.app.name }, image: source === null ? image : undefined }),
      undefined,
      { verb: "added", inlineErrors: true },
    );
    if (saved) onDone();
    else setError({ message: saveFailure(result) ?? (result.ok ? null : (result.message ?? null)), issues: result.ok ? [] : result.issues });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add environment to {project}</DialogTitle>
        <DialogDescription>
          {step === "form" ? "An environment is one more copy of the project: its own app, on the server you choose." : "Nothing has been written yet. This is what Add environment will do."}
        </DialogDescription>
      </DialogHeader>

      {step === "form" ? (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (plan.ok) setStep("review");
          }}
        >
          <TextField id="environment-name" label="Environment name" value={environment} onChange={setEnvironment} help="For example staging or pr-12." autoFocus />
          <ChoiceList
            id="environment-server"
            label="Server"
            value={serverId}
            onChange={setServerId}
            choices={servers.map((s) => ({ value: s.id, label: s.name, disabled: !s.enabled, detail: s.enabled ? (s.inProject ? `Already runs apps of ${project}` : undefined) : s.reason }))}
          />
          <SelectField
            id="environment-copy"
            label="Copy from"
            value={copy}
            onChange={setCopy}
            options={[...sources.map((s) => ({ value: s.key, label: `${s.environment}: ${s.app.name} on ${s.server.name}` })), { value: NONE, label: "Nothing: start from an image" }]}
            help="Copies the app's configuration. Variables and domains are never copied."
          />
          {source === null && <TextField id="environment-image" label="Image" value={image} onChange={setImage} mono help="The image repository, for example ghcr.io/acme/shop." />}
          {issue !== null && (
            <p role="alert" className={ERROR_TEXT}>
              {issue}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={!plan.ok}>
              Review
            </Button>
          </DialogFooter>
        </form>
      ) : (
        plan.ok && (
          <div className="grid gap-4 text-sm">
            <PlanSummary project={project} environment={environment.trim()} serverName={server?.name ?? serverId} plan={plan} />
            {error && (
              <div className="grid gap-2">
                {error.message && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-sm text-destructive">
                      {error.message}
                    </p>
                    <StepUpAction error={error.message} />
                  </div>
                )}
                {error.issues.length > 0 && <IssuesList issues={error.issues} />}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("form")} disabled={save.pending}>
                Back
              </Button>
              <Button type="button" loading={save.pending} onClick={add}>
                Add environment
              </Button>
            </DialogFooter>
          </div>
        )
      )}
      {save.dialogs}
    </>
  );
}

/** What adding the environment writes, what it leaves out, and what to look at before the first deploy. */
export function PlanSummary({ project, environment, serverName, plan }: { project: string; environment: string; serverName: string; plan: AddEnvironmentPlanned }) {
  const { config } = plan;
  return (
    <div className="grid gap-3" data-testid="environment-plan">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-3">
        <dt className="text-muted-foreground">App</dt>
        <dd className="font-mono break-all">{plan.appName}</dd>
        <dt className="text-muted-foreground">Server</dt>
        <dd>{serverName}</dd>
        <dt className="text-muted-foreground">Project</dt>
        <dd>{project}</dd>
        <dt className="text-muted-foreground">Environment</dt>
        <dd>{environment}</dd>
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono break-all">{config.image}</dd>
      </dl>
      {plan.copied.length > 0 && (
        <p>
          <span className="font-medium">Copied: </span>
          {plan.copied.length > 1 ? listFields(plan.copied) : "only the image"}
        </p>
      )}
      <p>
        <span className="font-medium">Not copied: </span>
        variables and domains. Set them for {environment} in its own Variables and Edit app.
      </p>
      <p className="text-muted-foreground">The app is added to the configuration and not deployed: deploy it from the Apps tab when it is ready.</p>
      {plan.warnings.map((w) => (
        <Notice key={w} tone="warning" title="Check before the first deploy">
          {w}
        </Notice>
      ))}
    </div>
  );
}
